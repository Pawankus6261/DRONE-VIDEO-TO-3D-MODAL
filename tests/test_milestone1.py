"""
Unit and Integration Tests for Milestone 1 (Video Ingestion & Adaptive Keyframing).
Includes synthetic video generator simulating drone motion over textured terrain.
"""

import os
import shutil
import tempfile
import unittest
from pathlib import Path
import cv2
import numpy as np

from reconstruction.config import VideoProcessingConfig, WorkspaceConfig
from reconstruction.utils.io import WorkspaceManager
from reconstruction.video.keyframe_selector import AdaptiveKeyframeSelector
from reconstruction.video.metadata import extract_video_metadata
from reconstruction.video.pipeline import VideoProcessingPipeline
from reconstruction.video.quality import FrameQualityAnalyzer


def create_synthetic_drone_video(
    output_path: Path,
    num_frames: int = 60,
    width: int = 640,
    height: int = 360,
    fps: int = 30
) -> Path:
    """
    Generates a synthetic drone video simulating translation over a textured terrain.
    Periodically injects intentional blur and duplicate frames to verify filters.
    """
    fourcc = cv2.VideoWriter.fourcc(*"mp4v")
    out = cv2.VideoWriter(str(output_path), fourcc, fps, (width, height))
    
    # Base textured grid pattern
    for i in range(num_frames):
        frame = np.zeros((height, width, 3), dtype=np.uint8)
        
        # Simulating camera motion by shifting grid coordinates
        offset_x = (i * 4) % width
        offset_y = (i * 2) % height
        
        # Draw textured grid & shapes
        cv2.rectangle(frame, (0, 0), (width, height), (34, 139, 34), -1) # Ground grass color
        
        for gx in range(0, width, 40):
            x_pos = (gx + offset_x) % width
            cv2.line(frame, (x_pos, 0), (x_pos, height), (50, 205, 50), 2)
            
        for gy in range(0, height, 40):
            y_pos = (gy + offset_y) % height
            cv2.line(frame, (0, y_pos), (width, y_pos), (50, 205, 50), 2)
            
        # Draw high-contrast buildings/markers
        marker_x = (200 + offset_x) % (width - 60)
        marker_y = (100 + offset_y) % (height - 60)
        cv2.rectangle(frame, (marker_x, marker_y), (marker_x + 50, marker_y + 50), (220, 220, 220), -1)
        cv2.circle(frame, (marker_x + 25, marker_y + 25), 15, (0, 0, 255), -1)
        
        # Intentional quality variations:
        # Frame 10..12: heavy Gaussian blur (motion blur simulation)
        if 10 <= i <= 12:
            frame = cv2.GaussianBlur(frame, (45, 45), 0)
            
        # Frame 25..27: identical duplicate (drone hovering in place)
        if 25 <= i <= 27:
            # reuse static position without moving offset
            frame = np.full((height, width, 3), 120, dtype=np.uint8)
            cv2.rectangle(frame, (100, 100), (200, 200), (255, 255, 255), -1)
            
        out.write(frame)
        
    out.release()
    return output_path


class TestMilestone1(unittest.TestCase):
    """Test suite for Milestone 1 components."""

    @classmethod
    def setUpClass(cls):
        cls.temp_dir = Path(tempfile.mkdtemp(prefix="sih_test_"))
        cls.synthetic_video = cls.temp_dir / "synthetic_drone.mp4"
        create_synthetic_drone_video(cls.synthetic_video, num_frames=60, width=640, height=360, fps=30)

    @classmethod
    def tearDownClass(cls):
        if cls.temp_dir.exists():
            shutil.rmtree(cls.temp_dir, ignore_errors=True)

    def test_video_metadata_extraction(self):
        """Verify video metadata extraction on synthetic video."""
        metadata = extract_video_metadata(self.synthetic_video)
        self.assertEqual(metadata.width, 640)
        self.assertEqual(metadata.height, 360)
        self.assertEqual(metadata.total_frames, 60)
        self.assertEqual(metadata.fps, 30.0)
        self.assertAlmostEqual(metadata.duration_sec, 2.0, delta=0.1)
        self.assertGreater(metadata.file_size_mb, 0.0)

    def test_video_metadata_invalid_file(self):
        """Verify FileNotFoundError on missing video."""
        with self.assertRaises(FileNotFoundError):
            extract_video_metadata(Path("non_existent_video.mp4"))

    def test_quality_analyzer_sharpness_and_blur(self):
        """Verify that sharp images pass and blurred images are detected."""
        analyzer = FrameQualityAnalyzer(min_sharpness_score=50.0)
        
        # Create sharp checkerboard image
        sharp_img = np.zeros((200, 200, 3), dtype=np.uint8)
        sharp_img[::20, :] = 255
        sharp_img[:, ::20] = 255
        
        metrics_sharp = analyzer.evaluate(sharp_img, frame_index=0, timestamp_sec=0.0)
        self.assertFalse(metrics_sharp.is_blurry)
        self.assertGreater(metrics_sharp.sharpness_score, 50.0)
        
        # Create blurred image
        blurry_img = cv2.GaussianBlur(sharp_img, (31, 31), 0)
        metrics_blurry = analyzer.evaluate(blurry_img, frame_index=1, timestamp_sec=0.033)
        self.assertTrue(metrics_blurry.is_blurry)
        self.assertLess(metrics_blurry.sharpness_score, metrics_sharp.sharpness_score)

    def test_quality_analyzer_exposure(self):
        """Verify rejection of underexposed and overexposed frames."""
        analyzer = FrameQualityAnalyzer(min_brightness=25.0, max_brightness=230.0)
        
        dark_img = np.full((100, 100, 3), 10, dtype=np.uint8)
        metrics_dark = analyzer.evaluate(dark_img, frame_index=0, timestamp_sec=0.0)
        self.assertFalse(metrics_dark.is_exposure_valid)
        
        bright_img = np.full((100, 100, 3), 245, dtype=np.uint8)
        metrics_bright = analyzer.evaluate(bright_img, frame_index=1, timestamp_sec=0.033)
        self.assertFalse(metrics_bright.is_exposure_valid)

    def test_adaptive_keyframe_selection(self):
        """Verify duplicate suppression and motion selection."""
        config = VideoProcessingConfig(
            min_interval_sec=0.1,
            max_interval_sec=1.5,
            min_motion_threshold=0.02,
            min_sharpness_score=30.0
        )
        selector = AdaptiveKeyframeSelector(config)
        
        # Initial frame with valid exposure
        frame1 = np.full((100, 100, 3), 100, dtype=np.uint8)
        frame1[::10, :] = 220
        rec1 = selector.process_frame(frame1, 0, 0.0)
        self.assertIsNotNone(rec1)
        self.assertEqual(rec1.selection_reason, "initial_frame")
        
        # Immediate duplicate (should be skipped due to min_interval)
        rec_dup_time = selector.process_frame(frame1, 1, 0.03)
        self.assertIsNone(rec_dup_time)
        
        # Duplicate after interval (should be skipped due to no motion)
        rec_dup_static = selector.process_frame(frame1, 10, 0.3)
        self.assertIsNone(rec_dup_static)
        
        # Frame with significant motion
        frame2 = np.full((100, 100, 3), 100, dtype=np.uint8)
        frame2[:, ::10] = 220
        rec_motion = selector.process_frame(frame2, 15, 0.5)
        self.assertIsNotNone(rec_motion)

    def test_full_pipeline_execution(self):
        """Integration test executing the full Milestone 1 pipeline on synthetic video."""
        project_id = "test_sih_m1"
        ws_config = WorkspaceConfig(base_dir=self.temp_dir / "workspace")
        
        pipeline_config = VideoProcessingConfig(
            min_interval_sec=0.1,
            max_keyframes=50,
            min_keyframes=3,
            min_sharpness_score=30.0
        )
        
        pipeline = VideoProcessingPipeline(
            project_id=project_id,
            config=pipeline_config,
            workspace_base=self.temp_dir / "workspace"
        )
        
        result = pipeline.process(self.synthetic_video)
        
        self.assertEqual(result["project_id"], project_id)
        self.assertEqual(result["status"], "success")
        self.assertGreater(result["keyframes_extracted"], 3)
        self.assertEqual(result["frames_read"], 60)
        
        # Verify workspace files
        ws = WorkspaceManager(project_id, ws_config)
        keyframes_dir = ws.get_path("keyframes")
        saved_keyframes = list(keyframes_dir.glob("*.png"))
        self.assertEqual(len(saved_keyframes), result["keyframes_extracted"])
        
        # Verify metadata files exist and are valid JSON
        meta = ws.read_json("metrics", "video_metadata.json")
        self.assertEqual(meta["width"], 640)
        
        report = ws.read_json("metrics", "keyframe_selection.json")
        self.assertEqual(report["keyframes_extracted"], result["keyframes_extracted"])
        
        # Verify log file
        log_path = ws.get_path("logs", "pipeline.log")
        self.assertTrue(log_path.exists())
        self.assertGreater(log_path.stat().st_size, 0)


if __name__ == "__main__":
    unittest.main()
