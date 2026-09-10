"""
Adaptive Keyframe Selection.
Evaluates camera motion, parallax, sharpness, and duplicate suppression in a single sequential pass.
"""

from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional
import cv2
import numpy as np

from reconstruction.config import VideoProcessingConfig
from reconstruction.video.quality import FrameQualityAnalyzer, FrameQualityMetrics


@dataclass
class KeyframeRecord:
    """Metadata record for an extracted keyframe."""
    keyframe_id: int
    frame_index: int
    timestamp_sec: float
    filename: str
    sharpness_score: float
    brightness_mean: float
    quality_score: float
    motion_score: float
    selection_reason: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class AdaptiveKeyframeSelector:
    """
    Streams sequential frames and selects an optimal subset of keyframes for Structure-from-Motion.
    Balances parallax/motion with image sharpness while pruning duplicate or blurry frames.
    """
    def __init__(self, config: VideoProcessingConfig):
        self.config = config
        self.analyzer = FrameQualityAnalyzer(
            min_sharpness_score=config.min_sharpness_score,
            min_brightness=config.min_brightness,
            max_brightness=config.max_brightness,
            processing_resolution=config.processing_resolution
        )
        self.selected_keyframes: List[KeyframeRecord] = []
        
        # State tracking
        self.last_keyframe_gray: Optional[np.ndarray] = None
        self.last_keyframe_time: float = -1.0
        self.last_keyframe_index: int = -1
        
        # Candidate buffer for local sharpness peak selection
        self.candidate_frame: Optional[np.ndarray] = None
        self.candidate_metrics: Optional[FrameQualityMetrics] = None
        self.candidate_motion: float = 0.0

    def compute_motion_score(self, current_gray: np.ndarray, reference_gray: np.ndarray) -> float:
        """
        Calculates motion magnitude between reference frame and current frame.
        Uses normalized mean absolute difference combined with edge motion.
        Returns value typically between 0.0 (identical) and 1.0 (completely distinct).
        """
        if current_gray.shape != reference_gray.shape:
            reference_gray = cv2.resize(reference_gray, (current_gray.shape[1], current_gray.shape[0]))
            
        diff = cv2.absdiff(current_gray, reference_gray)
        motion_score = float(np.mean(diff) / 255.0)
        return motion_score

    def compute_histogram_similarity(self, img1_gray: np.ndarray, img2_gray: np.ndarray) -> float:
        """
        Calculates correlation between grayscale histograms (1.0 = identical distribution).
        """
        hist1 = cv2.calcHist([img1_gray], [0], None, [32], [0, 256])
        hist2 = cv2.calcHist([img2_gray], [0], None, [32], [0, 256])
        cv2.normalize(hist1, hist1, alpha=0, beta=1, norm_type=cv2.NORM_MINMAX)
        cv2.normalize(hist2, hist2, alpha=0, beta=1, norm_type=cv2.NORM_MINMAX)
        correlation = cv2.compareHist(hist1, hist2, cv2.HISTCMP_CORREL)
        return correlation

    def process_frame(
        self,
        frame_bgr: np.ndarray,
        frame_index: int,
        timestamp_sec: float
    ) -> Optional[KeyframeRecord]:
        """
        Evaluates a frame sequentially. If the frame satisfies selection criteria,
        commits it and returns a KeyframeRecord. Otherwise returns None.
        """
        if len(self.selected_keyframes) >= self.config.max_keyframes:
            return None

        # Preprocess downscaled grayscale for metrics
        gray, _ = self.analyzer.preprocess_for_analysis(frame_bgr)
        metrics = self.analyzer.evaluate(frame_bgr, frame_index, timestamp_sec)

        # First frame bootstrap
        if self.last_keyframe_gray is None:
            if not metrics.is_exposure_valid or metrics.sharpness_score < (self.config.min_sharpness_score * 0.5):
                # Wait for a valid first frame if camera starts pointed at ground/black
                return None
            return self._commit_keyframe(
                frame_bgr=frame_bgr,
                gray=gray,
                frame_index=frame_index,
                timestamp_sec=timestamp_sec,
                metrics=metrics,
                motion_score=1.0,
                reason="initial_frame"
            )

        time_since_last = timestamp_sec - self.last_keyframe_time

        # Rule 1: Enforce minimum temporal spacing to prevent frame bursts
        if time_since_last < self.config.min_interval_sec:
            return None

        # Compute motion and duplicate similarity against last committed keyframe
        motion = self.compute_motion_score(gray, self.last_keyframe_gray)
        similarity = self.compute_histogram_similarity(gray, self.last_keyframe_gray)

        # Rule 2: Duplicate suppression
        if similarity > self.config.duplicate_similarity_threshold and motion < (self.config.min_motion_threshold * 0.5):
            return None

        # Rule 3: Blur & Exposure rejection unless timeout reached
        force_timeout = time_since_last >= self.config.max_interval_sec

        if metrics.is_blurry and not force_timeout:
            return None

        if not metrics.is_exposure_valid and not force_timeout:
            return None

        # Rule 4: Parallax / Camera Motion trigger
        if motion >= self.config.min_motion_threshold or force_timeout:
            reason = "timeout_continuity" if force_timeout else "camera_motion"
            return self._commit_keyframe(
                frame_bgr=frame_bgr,
                gray=gray,
                frame_index=frame_index,
                timestamp_sec=timestamp_sec,
                metrics=metrics,
                motion_score=motion,
                reason=reason
            )

        return None

    def _commit_keyframe(
        self,
        frame_bgr: np.ndarray,
        gray: np.ndarray,
        frame_index: int,
        timestamp_sec: float,
        metrics: FrameQualityMetrics,
        motion_score: float,
        reason: str
    ) -> KeyframeRecord:
        """Commits frame to internal keyframe tracking list."""
        keyframe_id = len(self.selected_keyframes) + 1
        filename = f"keyframe_{keyframe_id:04d}_f{frame_index:06d}.png"
        
        record = KeyframeRecord(
            keyframe_id=keyframe_id,
            frame_index=frame_index,
            timestamp_sec=round(timestamp_sec, 3),
            filename=filename,
            sharpness_score=metrics.sharpness_score,
            brightness_mean=metrics.brightness_mean,
            quality_score=metrics.quality_score,
            motion_score=round(motion_score, 4),
            selection_reason=reason
        )
        
        self.selected_keyframes.append(record)
        self.last_keyframe_gray = gray.copy()
        self.last_keyframe_time = timestamp_sec
        self.last_keyframe_index = frame_index
        return record
