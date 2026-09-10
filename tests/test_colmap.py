"""
Tests for COLMAP integration (pycolmap & colmap submodule).
"""

import unittest
from pathlib import Path
from reconstruction.colmap import ColmapPipeline, is_colmap_available


class TestColmapIntegration(unittest.TestCase):
    def test_colmap_availability(self):
        """Verify that pycolmap is installed and available."""
        self.assertTrue(is_colmap_available(), "pycolmap should be installed and available.")

    def test_colmap_pipeline_initialization(self):
        """Verify ColmapPipeline initializes with parameters."""
        pipeline = ColmapPipeline(max_image_size=1024, max_num_features=1500)
        self.assertEqual(pipeline.max_image_size, 1024)
        self.assertEqual(pipeline.max_num_features, 1500)
        self.assertFalse(pipeline.use_gpu)

    def test_external_colmap_directory(self):
        """Verify that external/colmap git repository is present."""
        colmap_repo = Path("external/colmap")
        self.assertTrue(colmap_repo.exists(), "external/colmap directory should exist.")
        self.assertTrue((colmap_repo / "CMakeLists.txt").exists(), "COLMAP CMakeLists.txt should be present.")


if __name__ == "__main__":
    unittest.main()
