"""
Unit tests for Depth Anything V2 integration.
"""

import unittest
import numpy as np
from reconstruction.depth.depth_anything import DepthAnythingEstimator, is_depth_anything_available
from reconstruction.depth.estimator import DepthEstimator


class TestDepthAnythingV2(unittest.TestCase):
    def test_depth_anything_availability(self):
        """Verify Depth Anything V2 repository and weights are present."""
        self.assertTrue(is_depth_anything_available(), "Depth Anything V2 should be available.")

    def test_depth_anything_inference(self):
        """Verify Depth Anything V2 neural depth estimation on an image."""
        estimator = DepthAnythingEstimator()
        # Synthetic test image
        test_img = np.zeros((360, 640, 3), dtype=np.uint8)
        test_img[100:260, 200:440] = [120, 200, 255]

        result = estimator.estimate(test_img)
        self.assertIsNotNone(result.depth_map)
        self.assertEqual(result.depth_map.shape, (360, 640))
        self.assertEqual(result.confidence_map.shape, (360, 640))
        self.assertEqual(result.depth_colored.shape, (360, 640, 3))
        self.assertGreater(result.mean_depth, 0.0)

    def test_depth_estimator_integration(self):
        """Verify DepthEstimator uses Depth Anything V2 by default."""
        estimator = DepthEstimator(method="depth_anything")
        test_img = np.ones((240, 320, 3), dtype=np.uint8) * 150
        result = estimator.estimate_from_pair(test_img)
        self.assertIsNotNone(result.depth_map)
        self.assertEqual(result.depth_map.shape, (240, 320))


if __name__ == "__main__":
    unittest.main()
