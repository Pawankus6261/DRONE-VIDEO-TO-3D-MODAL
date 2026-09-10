"""
Video Processing Pipeline Execution.
Orchestrates sequential video ingestion, quality evaluation, keyframe persistence,
and metrics generation for Milestone 1.
"""

import argparse
import shutil
import time
from pathlib import Path
from typing import Any, Dict, Optional
import cv2

from reconstruction.config import DEFAULT_CONFIG, VideoProcessingConfig
from reconstruction.utils.io import WorkspaceManager
from reconstruction.utils.logger import setup_logger
from reconstruction.video.keyframe_selector import AdaptiveKeyframeSelector
from reconstruction.video.metadata import extract_video_metadata


class VideoProcessingPipeline:
    """
    Executes Milestone 1: Video to Filtered Keyframes.
    Designed for memory-constrained local hardware (batch-less sequential streaming).
    """
    def __init__(
        self,
        project_id: str,
        config: VideoProcessingConfig = DEFAULT_CONFIG.video,
        workspace_base: Optional[Path] = None
    ):
        self.project_id = project_id
        self.config = config
        
        ws_config = DEFAULT_CONFIG.workspace
        if workspace_base is not None:
            ws_config.base_dir = Path(workspace_base)
            
        self.workspace = WorkspaceManager(project_id, ws_config)
        self.workspace.init_workspace()
        
        log_file = self.workspace.get_path("logs", "pipeline.log")
        self.logger = setup_logger(f"pipeline.{project_id}", log_file=log_file)

    def process(self, video_path: Path) -> Dict[str, Any]:
        """
        Execute full Milestone 1 ingestion and keyframe extraction.
        
        Args:
            video_path: Absolute or relative path to the input video.
            
        Returns:
            Dict containing processing metrics and extraction summary.
        """
        video_path = Path(video_path).resolve()
        self.logger.info(f"Starting Milestone 1 processing for project '{self.project_id}'")
        self.logger.info(f"Input video: {video_path}")
        
        start_time = time.time()
        
        # 1. Video Metadata Extraction
        metadata = extract_video_metadata(video_path)
        self.logger.info(
            f"Video probed: {metadata.width}x{metadata.height} @ {metadata.fps:.2f}fps, "
            f"Total Frames: {metadata.total_frames}, Duration: {metadata.duration_sec:.2f}s"
        )
        
        # Copy original video into project input sandbox
        target_video_path = self.workspace.get_path("input", "video.mp4")
        if target_video_path != video_path:
            shutil.copy2(video_path, target_video_path)
            self.logger.info(f"Staged input video to: {target_video_path}")
            
        self.workspace.write_json("metrics", "video_metadata.json", metadata.to_dict())

        # 2. Sequential Keyframe Extraction
        selector = AdaptiveKeyframeSelector(self.config)
        keyframes_dir = self.workspace.get_path("keyframes")
        
        cap = cv2.VideoCapture(str(target_video_path))
        if not cap.isOpened():
            raise RuntimeError(f"Failed to open staged video file: {target_video_path}")

        frame_idx = 0
        processed_count = 0
        extracted_records = []
        
        try:
            while True:
                ret, frame = cap.read()
                if not ret or frame is None:
                    break
                    
                timestamp_sec = frame_idx / metadata.fps if metadata.fps > 0 else 0.0
                
                # Evaluate frame sequentially
                record = selector.process_frame(frame, frame_idx, timestamp_sec)
                
                if record is not None:
                    # Save keyframe image to disk (RAM safe: write immediately, drop frame)
                    out_path = keyframes_dir / record.filename
                    
                    if self.config.save_resolution is not None:
                        h, w = frame.shape[:2]
                        if max(h, w) > self.config.save_resolution:
                            scale = self.config.save_resolution / max(h, w)
                            frame_to_save = cv2.resize(frame, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
                        else:
                            frame_to_save = frame
                    else:
                        frame_to_save = frame
                        
                    cv2.imwrite(str(out_path), frame_to_save)
                    extracted_records.append(record.to_dict())
                    self.logger.info(
                        f"Extracted [{record.keyframe_id:03d}] Frame #{frame_idx} ({timestamp_sec:.2f}s) "
                        f"- Sharpness: {record.sharpness_score:.1f}, Motion: {record.motion_score:.3f} [{record.selection_reason}]"
                    )

                frame_idx += 1
                processed_count += 1
                
                if len(selector.selected_keyframes) >= self.config.max_keyframes:
                    self.logger.info(f"Reached MAX_KEYFRAMES limit ({self.config.max_keyframes}). Stopping stream.")
                    break
                    
        finally:
            cap.release()

        elapsed_time = round(time.time() - start_time, 2)
        keyframe_count = len(extracted_records)
        
        # 3. Quality Validation Check
        if keyframe_count < self.config.min_keyframes:
            self.logger.warning(
                f"Extracted {keyframe_count} keyframes, which is below the recommended minimum "
                f"of {self.config.min_keyframes} for stable SfM reconstruction."
            )
            
        # 4. Save Keyframe Selection Report
        summary = {
            "project_id": self.project_id,
            "status": "success" if keyframe_count >= self.config.min_keyframes else "low_keyframe_count",
            "frames_read": processed_count,
            "keyframes_extracted": keyframe_count,
            "extraction_ratio": round(keyframe_count / max(1, processed_count), 4),
            "elapsed_time_sec": elapsed_time,
            "processing_fps": round(processed_count / max(0.001, elapsed_time), 2),
            "keyframes": extracted_records
        }
        
        self.workspace.write_json("metrics", "keyframe_selection.json", summary)
        self.logger.info(
            f"Milestone 1 completed in {elapsed_time}s: "
            f"{keyframe_count} keyframes extracted from {processed_count} frames."
        )
        
        return summary


def main():
    parser = argparse.ArgumentParser(description="SIH26158 Video Ingestion & Keyframe Extraction (Milestone 1)")
    parser.add_argument("--video", type=str, required=True, help="Path to input drone video (.mp4)")
    parser.add_argument("--project-id", type=str, default="project_default", help="Project identifier for workspace sandbox")
    parser.add_argument("--max-keyframes", type=int, default=200, help="Maximum number of keyframes to extract")
    parser.add_argument("--processing-res", type=int, default=640, help="Resolution for analysis & quality checks")
    args = parser.parse_args()

    config = VideoProcessingConfig(
        max_keyframes=args.max_keyframes,
        processing_resolution=args.processing_res
    )
    
    pipeline = VideoProcessingPipeline(project_id=args.project_id, config=config)
    result = pipeline.process(Path(args.video))
    print("\n--- Pipeline Summary ---")
    print(f"Status: {result['status']}")
    print(f"Keyframes Extracted: {result['keyframes_extracted']}")
    print(f"Processing Time: {result['elapsed_time_sec']}s")


if __name__ == "__main__":
    main()
