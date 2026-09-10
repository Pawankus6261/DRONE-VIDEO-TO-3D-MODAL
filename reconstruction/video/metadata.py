"""
Video Metadata Extraction.
Inspects video properties using OpenCV without reading frames into RAM.
"""

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict
import cv2


@dataclass
class VideoMetadata:
    """Metadata container for an ingested drone video."""
    file_path: str
    file_name: str
    file_size_mb: float
    width: int
    height: int
    fps: float
    total_frames: int
    duration_sec: float
    fourcc: str
    aspect_ratio: float

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def extract_video_metadata(video_path: Path) -> VideoMetadata:
    """
    Inspects video file properties sequentially.
    
    Args:
        video_path: Path to the video file.
        
    Returns:
        VideoMetadata dataclass populated with container and stream metrics.
        
    Raises:
        FileNotFoundError: If video does not exist.
        ValueError: If video cannot be opened or contains 0 frames.
    """
    video_path = Path(video_path).resolve()
    if not video_path.is_file():
        raise FileNotFoundError(f"Video file does not exist: {video_path}")
        
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise ValueError(f"OpenCV could not open video container: {video_path}")
        
    try:
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fourcc_int = int(cap.get(cv2.CAP_PROP_FOURCC))
        fourcc = "".join([chr((fourcc_int >> 8 * i) & 0xFF) for i in range(4)])
        
        # Fallback if fps is zero or corrupt
        if fps <= 0:
            fps = 30.0
            
        duration_sec = total_frames / fps if total_frames > 0 and fps > 0 else 0.0
        aspect_ratio = round(width / height, 4) if height > 0 else 0.0
        file_size_mb = round(video_path.stat().st_size / (1024 * 1024), 2)
        
        if width <= 0 or height <= 0 or total_frames <= 0:
            raise ValueError(
                f"Invalid or corrupted video stream (width={width}, height={height}, frames={total_frames})"
            )
            
        return VideoMetadata(
            file_path=str(video_path),
            file_name=video_path.name,
            file_size_mb=file_size_mb,
            width=width,
            height=height,
            fps=round(fps, 2),
            total_frames=total_frames,
            duration_sec=round(duration_sec, 2),
            fourcc=fourcc,
            aspect_ratio=aspect_ratio
        )
    finally:
        cap.release()
