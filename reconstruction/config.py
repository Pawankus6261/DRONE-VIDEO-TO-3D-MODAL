"""
Global Configuration for SIH26158 3D Reconstruction Pipeline.
Optimized for local execution on Windows with RTX 3050 (4GB VRAM) and 16GB RAM.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional


@dataclass
class VideoProcessingConfig:
    """Configuration for video ingestion, quality filtering, and keyframe extraction."""
    # Analysis resolution: downscale frame during quality/motion check to conserve memory & CPU
    processing_resolution: int = 640
    
    # Save resolution for keyframes (None = preserve original video resolution for high quality texture & SfM)
    save_resolution: Optional[int] = None
    
    # Hard bounds on extracted keyframe counts
    max_keyframes: int = 200
    min_keyframes: int = 15
    
    # Temporal constraints (seconds)
    min_interval_sec: float = 0.25   # Avoid bursting nearly identical frames (< 250ms)
    max_interval_sec: float = 2.5    # Force a keyframe if camera moved slowly to maintain track continuity
    
    # Blur & sharpness detection (variance of Laplacian)
    min_sharpness_score: float = 60.0
    
    # Exposure thresholds (mean pixel intensity 0..255)
    min_brightness: float = 25.0     # Reject underexposed / pitch black frames
    max_brightness: float = 230.0    # Reject washed out / blown out highlights
    
    # Motion & parallax detection
    # Normalized pixel difference / optical flow magnitude threshold to register significant camera motion
    min_motion_threshold: float = 0.025
    
    # Duplicate suppression (histogram correlation or perceptual similarity above this is considered duplicate)
    duplicate_similarity_threshold: float = 0.96


@dataclass
class WorkspaceConfig:
    """Configuration for local project sandbox paths."""
    base_dir: Path = Path("workspace")
    subdirs: List[str] = field(default_factory=lambda: [
        "input",
        "frames",
        "keyframes",
        "calibration",
        "colmap",
        "depth",
        "poses",
        "pointcloud",
        "mesh",
        "textures",
        "geospatial",
        "metrics",
        "logs"
    ])


@dataclass
class PipelineConfig:
    """Master pipeline configuration."""
    video: VideoProcessingConfig = field(default_factory=VideoProcessingConfig)
    workspace: WorkspaceConfig = field(default_factory=WorkspaceConfig)


# Global default instance
DEFAULT_CONFIG = PipelineConfig()
