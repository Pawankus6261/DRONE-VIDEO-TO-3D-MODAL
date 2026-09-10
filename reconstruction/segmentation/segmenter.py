"""
SIH26158: YOLOv8 Instance Segmentation
Wraps Ultralytics YOLOv8 segmentation for extracting semantic masks, objects,
and terrain components from drone keyframes.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Union
import cv2
import numpy as np


@dataclass
class DetectionItem:
    class_id: int
    class_name: str
    confidence: float
    bbox: List[float]  # [x1, y1, x2, y2]
    area_percent: float


@dataclass
class SegmentationResult:
    keyframe_stem: str
    detections: List[DetectionItem]
    overlay_image: np.ndarray
    mask_colored: np.ndarray
    class_mask: np.ndarray
    summary: Dict[str, Union[int, float, List[Dict]]]


class YOLOSegmenter:
    """
    YOLOv8 Instance Segmenter for drone video keyframes.
    Segments structural objects, vehicles, vegetation, roads, and people.
    """

    # Palette of distinct vibrant colors for segment masks
    COLOR_PALETTE = [
        (0, 255, 128),   # Emerald green
        (255, 128, 0),   # Vibrant orange
        (0, 180, 255),   # Bright cyan-blue
        (255, 50, 150),  # Magenta
        (255, 230, 0),   # Yellow
        (160, 50, 255),  # Violet
        (50, 255, 230),  # Aqua
        (255, 80, 80),   # Coral red
        (120, 255, 50),  # Lime
        (255, 150, 200), # Soft pink
    ]

    def __init__(self, model_path: str = "yolov8n-seg.pt", conf_thresh: float = 0.25):
        self.model_path = model_path
        self.conf_thresh = conf_thresh
        self._model = None
        self._load_model()

    def _load_model(self):
        try:
            from ultralytics import YOLO
            self._model = YOLO(self.model_path)
            # Warmup or check names
            self.class_names = self._model.names
        except Exception as e:
            print(f"[YOLO] Warning: Failed to initialize YOLO model: {e}")
            self._model = None
            self.class_names = {}

    def is_available(self) -> bool:
        return self._model is not None

    def segment_image(
        self,
        image_input: Union[str, Path, np.ndarray],
        stem: str = "keyframe"
    ) -> SegmentationResult:
        """
        Runs instance segmentation on an image.
        Returns visual overlays, semantic masks, and structured detection metrics.
        """
        if isinstance(image_input, (str, Path)):
            stem = Path(image_input).stem
            img = cv2.imread(str(image_input))
            if img is None:
                raise FileNotFoundError(f"Could not load image from {image_input}")
        else:
            img = image_input.copy()

        h, w = img.shape[:2]

        if not self.is_available():
            # Graceful fallback: return blank masks
            return SegmentationResult(
                keyframe_stem=stem,
                detections=[],
                overlay_image=img,
                mask_colored=np.zeros_like(img),
                class_mask=np.zeros((h, w), dtype=np.int32),
                summary={"total_objects": 0, "detected_classes": [], "detections": []}
            )

        # Run inference (fast half precision if CUDA available)
        results = self._model.predict(
            source=img,
            conf=self.conf_thresh,
            verbose=False
        )

        detections: List[DetectionItem] = []
        overlay = img.copy()
        mask_colored = np.zeros_like(img)
        class_mask = np.zeros((h, w), dtype=np.int32)
        total_pixels = h * w

        if results and len(results) > 0:
            res = results[0]
            boxes = res.boxes
            masks = res.masks

            if masks is not None and boxes is not None:
                orig_masks = masks.data.cpu().numpy()  # (N, H_mask, W_mask)
                xyxy = boxes.xyxy.cpu().numpy()
                confs = boxes.conf.cpu().numpy()
                classes = boxes.cls.cpu().numpy().astype(int)

                for idx in range(len(classes)):
                    cls_id = int(classes[idx])
                    cls_name = self.class_names.get(cls_id, f"obj_{cls_id}")
                    conf_val = float(confs[idx])
                    box = [float(v) for v in xyxy[idx]]

                    # Resize polygon mask to native image resolution
                    raw_mask = orig_masks[idx]
                    bin_mask = cv2.resize(raw_mask, (w, h), interpolation=cv2.INTER_LINEAR) > 0.5

                    mask_area = int(np.sum(bin_mask))
                    area_pct = round(float(mask_area / total_pixels * 100.0), 2)

                    color = self.COLOR_PALETTE[cls_id % len(self.COLOR_PALETTE)]

                    # Composite into colored mask
                    mask_colored[bin_mask] = color
                    class_mask[bin_mask] = cls_id + 1  # 1-indexed

                    # Draw bounding box and label badge on overlay
                    x1, y1, x2, y2 = [int(v) for v in box]
                    cv2.rectangle(overlay, (x1, y1), (x2, y2), color, 2)

                    # Label background
                    label = f"{cls_name} {int(conf_val * 100)}%"
                    (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
                    y_text = max(y1 - 6, th + 6)
                    cv2.rectangle(overlay, (x1, y_text - th - 4), (x1 + tw + 6, y_text + 4), color, -1)
                    cv2.putText(
                        overlay,
                        label,
                        (x1 + 3, y_text),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.6,
                        (0, 0, 0),
                        2,
                        cv2.LINE_AA
                    )

                    detections.append(
                        DetectionItem(
                            class_id=cls_id,
                            class_name=cls_name,
                            confidence=round(conf_val, 3),
                            bbox=[round(v, 1) for v in box],
                            area_percent=area_pct
                        )
                    )

                # Blend mask with original image for rich glassmorphic effect
                blended = cv2.addWeighted(overlay, 0.65, mask_colored, 0.35, 0)
                # Keep bounding boxes and text crisp
                has_mask = (mask_colored > 0).any(axis=2)
                overlay[has_mask] = blended[has_mask]

        # Summary aggregates
        class_counts: Dict[str, int] = {}
        for d in detections:
            class_counts[d.class_name] = class_counts.get(d.class_name, 0) + 1

        summary = {
            "keyframe": stem,
            "total_objects": len(detections),
            "detected_classes": [f"{name} ({count})" for name, count in class_counts.items()],
            "detections": [
                {
                    "class_name": d.class_name,
                    "confidence": d.confidence,
                    "bbox": d.bbox,
                    "area_percent": d.area_percent
                }
                for d in detections
            ]
        }

        return SegmentationResult(
            keyframe_stem=stem,
            detections=detections,
            overlay_image=overlay,
            mask_colored=mask_colored,
            class_mask=class_mask,
            summary=summary
        )
