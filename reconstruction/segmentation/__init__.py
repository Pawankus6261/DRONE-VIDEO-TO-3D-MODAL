"""
SIH26158: Semantic & Instance Segmentation Module
Supports YOLOv8 Instance Segmentation for keyframe object and terrain extraction.
"""

from .segmenter import YOLOSegmenter, SegmentationResult

__all__ = ["YOLOSegmenter", "SegmentationResult"]
