import unittest
import numpy as np
import cv2
from pathlib import Path
from reconstruction.segmentation import YOLOSegmenter, SegmentationResult


class TestYOLOSegmentation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.segmenter = YOLOSegmenter()

    def test_segmenter_availability(self):
        self.assertTrue(self.segmenter.is_available(), "YOLO model failed to initialize")
        self.assertIn(0, self.segmenter.class_names)
        self.assertEqual(self.segmenter.class_names[0], "person")
        self.assertEqual(self.segmenter.class_names[2], "car")

    def test_segment_synthetic_image(self):
        # Create a test image with a synthetic car-like rectangle
        img = np.zeros((480, 640, 3), dtype=np.uint8)
        # Draw some colored shapes
        cv2.rectangle(img, (100, 100), (300, 250), (200, 50, 50), -1)
        cv2.circle(img, (150, 260), 25, (50, 50, 50), -1)
        cv2.circle(img, (250, 260), 25, (50, 50, 50), -1)

        result = self.segmenter.segment_image(img, stem="test_synthetic")
        self.assertIsInstance(result, SegmentationResult)
        self.assertEqual(result.overlay_image.shape, (480, 640, 3))
        self.assertEqual(result.mask_colored.shape, (480, 640, 3))
        self.assertEqual(result.class_mask.shape, (480, 640))
        self.assertIn("total_objects", result.summary)
        self.assertIn("detections", result.summary)

    def test_segment_real_drone_keyframe(self):
        keyframe_path = Path("workspace/hjgjghjghj/keyframes/keyframe_0001_f000000.png")
        if not keyframe_path.exists():
            self.skipTest("No drone keyframe found in workspace")

        result = self.segmenter.segment_image(keyframe_path)
        self.assertIsInstance(result, SegmentationResult)
        self.assertGreater(result.overlay_image.shape[0], 0)
        self.assertGreater(result.overlay_image.shape[1], 0)
        print(f"\n[Test] Real Keyframe YOLO Detections: {result.summary['detected_classes']}")


if __name__ == "__main__":
    unittest.main()
