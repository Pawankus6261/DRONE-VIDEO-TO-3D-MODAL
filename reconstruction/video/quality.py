"""
Frame Quality and Sharpness Analysis.
Computes Laplacian variance, contrast distribution, and exposure suitability.
"""

from dataclasses import asdict, dataclass
from typing import Any, Dict, Tuple
import cv2
import numpy as np


@dataclass
class FrameQualityMetrics:
    """Quality indicators for an individual video frame."""
    frame_index: int
    timestamp_sec: float
    sharpness_score: float
    brightness_mean: float
    contrast_std: float
    is_blurry: bool
    is_exposure_valid: bool
    quality_score: float

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class FrameQualityAnalyzer:
    """
    Evaluates individual frame suitability for photogrammetry/SfM.
    SfM requires sharp edges and balanced exposure for reliable feature tracking.
    """
    def __init__(
        self,
        min_sharpness_score: float = 60.0,
        min_brightness: float = 25.0,
        max_brightness: float = 230.0,
        processing_resolution: int = 640
    ):
        self.min_sharpness = min_sharpness_score
        self.min_brightness = min_brightness
        self.max_brightness = max_brightness
        self.processing_resolution = processing_resolution

    def preprocess_for_analysis(self, frame_bgr: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        """
        Downsamples frame to target processing resolution and converts to grayscale.
        Returns: (resized_gray, resized_bgr)
        """
        h, w = frame_bgr.shape[:2]
        if max(h, w) > self.processing_resolution:
            scale = self.processing_resolution / max(h, w)
            new_w = int(w * scale)
            new_h = int(h * scale)
            resized_bgr = cv2.resize(frame_bgr, (new_w, new_h), interpolation=cv2.INTER_AREA)
        else:
            resized_bgr = frame_bgr
            
        gray = cv2.cvtColor(resized_bgr, cv2.COLOR_BGR2GRAY)
        return gray, resized_bgr

    def evaluate(self, frame_bgr: np.ndarray, frame_index: int, timestamp_sec: float) -> FrameQualityMetrics:
        """
        Compute sharpness (Laplacian variance), exposure, and quality score.
        """
        gray, _ = self.preprocess_for_analysis(frame_bgr)
        
        # Laplacian variance measures high-frequency edges (sharpness)
        laplacian = cv2.Laplacian(gray, cv2.CV_64F)
        sharpness = float(laplacian.var())
        
        # Exposure & contrast analysis
        brightness = float(np.mean(gray))
        contrast = float(np.std(gray))
        
        is_blurry = sharpness < self.min_sharpness
        is_exposure_valid = self.min_brightness <= brightness <= self.max_brightness
        
        # Composite score normalized approximately to 0..100
        # High sharpness and moderate-to-high contrast contribute positively
        sharpness_norm = min(100.0, (sharpness / 200.0) * 60.0)
        contrast_norm = min(40.0, (contrast / 64.0) * 40.0)
        penalty = 0.0 if is_exposure_valid else -50.0
        
        quality_score = max(0.0, min(100.0, sharpness_norm + contrast_norm + penalty))
        
        return FrameQualityMetrics(
            frame_index=frame_index,
            timestamp_sec=round(timestamp_sec, 3),
            sharpness_score=round(sharpness, 2),
            brightness_mean=round(brightness, 2),
            contrast_std=round(contrast, 2),
            is_blurry=is_blurry,
            is_exposure_valid=is_exposure_valid,
            quality_score=round(quality_score, 2)
        )
