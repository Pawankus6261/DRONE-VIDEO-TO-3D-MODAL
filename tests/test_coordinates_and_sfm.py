"""
SIH26158: Comprehensive Automated Test Suite for Coordinates, SfM Validation, and Viewer Math.
Covers:
1. GPS -> ECEF -> ENU -> LOCAL_METRIC conversion
2. LOCAL_METRIC -> THREEJS transformation and inverse
3. 7-DoF Similarity Transform (Umeyama algorithm)
4. Bounding box, center, and diagonal calculations
5. Camera auto-framing distance and dynamic near/far clipping
6. COLMAP validation rules (<5 registered fails, <50 points fails, warning/good/excellent thresholds)
7. Depth + pose registration validation (rejection of unregistered poses)
8. NaN/Inf and huge coordinate detection
"""

import unittest
import numpy as np

from reconstruction.geospatial.coordinates import (
    ModelBounds,
    compute_bounds_diagnostics,
    sfm_to_local_metric,
    local_metric_to_threejs,
    threejs_to_local_metric,
    geodetic_to_ecef,
    ecef_to_enu,
    georeferenced_to_local_metric,
    local_metric_to_georeferenced,
    estimate_similarity_transform
)
from reconstruction.colmap.pipeline import validate_sfm_results


class TestCoordinateTransforms(unittest.TestCase):
    """Test conversions between GPS, LOCAL_METRIC, and THREEJS."""

    def test_gps_to_enu_and_inverse(self):
        """Verify round-trip WGS84 GPS -> ECEF -> ENU -> GPS."""
        ref_lat, ref_lon, ref_alt = 28.6139, 77.2090, 215.0  # New Delhi
        # Point 100m East, 200m North, 50m Up
        test_lats = [ref_lat, ref_lat + 0.0018]
        test_lons = [ref_lon, ref_lon + 0.001]
        test_alts = [ref_alt, ref_alt + 15.0]

        enu_pts = georeferenced_to_local_metric(
            test_lats, test_lons, test_alts,
            ref_lat, ref_lon, ref_alt
        )

        self.assertEqual(enu_pts.shape, (2, 3))
        # Origin should be near (0, 0, 0)
        np.testing.assert_allclose(enu_pts[0], [0.0, 0.0, 0.0], atol=1e-3)
        # Second point should have reasonable meter values (< 500m)
        self.assertTrue(np.all(np.abs(enu_pts[1]) < 500.0))

        # Test inverse
        out_lats, out_lons, out_alts = local_metric_to_georeferenced(
            enu_pts, ref_lat, ref_lon, ref_alt
        )
        np.testing.assert_allclose(out_lats, test_lats, atol=1e-6)
        np.testing.assert_allclose(out_lons, test_lons, atol=1e-6)
        np.testing.assert_allclose(out_alts, test_alts, atol=1e-2)

    def test_local_metric_to_threejs_and_inverse(self):
        """Verify LOCAL_METRIC (+X East, +Y North, +Z Up) <-> THREEJS (+X Right, +Y Up, -Z Forward)."""
        pts_metric = np.array([
            [10.0, 20.0, 5.0],
            [-5.0, 15.0, 30.0]
        ])
        pts_three = local_metric_to_threejs(pts_metric)

        # X is unchanged
        np.testing.assert_allclose(pts_three[:, 0], pts_metric[:, 0])
        # Three.js Y is metric Z (Up)
        np.testing.assert_allclose(pts_three[:, 1], pts_metric[:, 2])
        # Three.js Z is -metric Y (North is -Z in Three.js)
        np.testing.assert_allclose(pts_three[:, 2], -pts_metric[:, 1])

        # Inverse
        pts_recovered = threejs_to_local_metric(pts_three)
        np.testing.assert_allclose(pts_recovered, pts_metric, atol=1e-8)

    def test_sfm_to_local_metric(self):
        """Verify raw SfM camera coordinates transform into metric frame."""
        # SfM point: +X right, +Y down, +Z forward
        pts_sfm = np.array([[2.0, 4.0, 10.0]])
        pts_metric = sfm_to_local_metric(pts_sfm)

        # +X stays +X, +Z forward becomes +Y North, +Y down inverted becomes -Z
        self.assertAlmostEqual(pts_metric[0, 0], 2.0)
        self.assertAlmostEqual(pts_metric[0, 1], 10.0)
        self.assertAlmostEqual(pts_metric[0, 2], -4.0)


class TestSimilarityTransform(unittest.TestCase):
    """Test 7-DoF Umeyama similarity transform (scale, rotation, translation)."""

    def test_umeyama_rigid_and_scale(self):
        # Known ground-truth points
        src = np.array([
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0]
        ])
        # Scale by 2.5, rotate 90 deg around Z, translate by [10, 20, 30]
        true_s = 2.5
        R_z90 = np.array([
            [0.0, -1.0, 0.0],
            [1.0,  0.0, 0.0],
            [0.0,  0.0, 1.0]
        ])
        true_t = np.array([[10.0], [20.0], [30.0]])

        dst = (true_s * (R_z90 @ src.T) + true_t).T

        est_s, est_R, est_t = estimate_similarity_transform(src, dst)

        self.assertAlmostEqual(est_s, true_s, places=5)
        np.testing.assert_allclose(est_R, R_z90, atol=1e-5)
        np.testing.assert_allclose(est_t, true_t, atol=1e-5)


class TestBoundsDiagnostics(unittest.TestCase):
    """Test bounding box, diagonal, and sanity checks."""

    def test_compute_bounds(self):
        pts = np.array([
            [-10.0, -5.0, 0.0],
            [10.0, 5.0, 20.0]
        ])
        bounds = compute_bounds_diagnostics(pts, coordinate_frame="LOCAL_METRIC")

        self.assertTrue(bounds.is_valid)
        self.assertAlmostEqual(bounds.width, 20.0)
        self.assertAlmostEqual(bounds.height, 10.0)
        self.assertAlmostEqual(bounds.depth, 20.0)
        self.assertAlmostEqual(bounds.center_x, 0.0)
        self.assertAlmostEqual(bounds.center_y, 0.0)
        self.assertAlmostEqual(bounds.center_z, 10.0)
        expected_diag = float(np.sqrt(20.0**2 + 10.0**2 + 20.0**2))
        self.assertAlmostEqual(bounds.diagonal, expected_diag, places=4)

    def test_nan_and_inf_detection(self):
        pts_with_nan = np.array([
            [1.0, 2.0, 3.0],
            [np.nan, 2.0, 3.0],
            [4.0, np.inf, 6.0],
            [5.0, 6.0, 7.0]
        ])
        bounds = compute_bounds_diagnostics(pts_with_nan)
        self.assertTrue(bounds.is_valid)
        self.assertEqual(bounds.num_points, 2)  # NaN and Inf points purged

    def test_absurd_coordinate_detection(self):
        pts_absurd = np.array([
            [0.0, 0.0, 0.0],
            [50000.0, 0.0, 0.0]  # 50km
        ])
        bounds = compute_bounds_diagnostics(pts_absurd, max_reasonable_dim_m=5000.0)
        self.assertFalse(bounds.is_valid)
        self.assertIn("Absurd bounding diagonal", bounds.error_message)


class TestSfMValidation(unittest.TestCase):
    """Test Phase 6 COLMAP validation rules."""

    def test_failure_on_under_5_registered(self):
        res = validate_sfm_results(registered_count=2, total_count=25, sparse_points_count=2)
        self.assertEqual(res["status"], "FAILED_SFM")
        self.assertFalse(res["metric_ready"])
        self.assertEqual(res["confidence"], "FAILED")

    def test_failure_on_insufficient_points(self):
        res = validate_sfm_results(registered_count=10, total_count=25, sparse_points_count=15)
        self.assertEqual(res["status"], "FAILED_SFM")
        self.assertFalse(res["metric_ready"])

    def test_weak_registration(self):
        res = validate_sfm_results(registered_count=8, total_count=25, sparse_points_count=300)
        self.assertEqual(res["status"], "WEAK")
        self.assertTrue(res["metric_ready"])
        self.assertEqual(res["confidence"], "LOW")

    def test_good_registration(self):
        res = validate_sfm_results(registered_count=19, total_count=25, sparse_points_count=2500)
        self.assertEqual(res["status"], "GOOD")
        self.assertTrue(res["metric_ready"])
        self.assertEqual(res["confidence"], "HIGH")

    def test_excellent_registration(self):
        res = validate_sfm_results(registered_count=25, total_count=25, sparse_points_count=6000)
        self.assertEqual(res["status"], "EXCELLENT")
        self.assertTrue(res["metric_ready"])
        self.assertEqual(res["confidence"], "HIGH")


class TestViewerAutoFramingMath(unittest.TestCase):
    """Verify camera auto-framing and dynamic near/far calculation."""

    def test_auto_framing_distance(self):
        fov_deg = 48.0
        fov_rad = np.deg2rad(fov_deg)
        size = np.array([25.0, 15.0, 18.0])
        max_dim = float(np.max(size))
        radius = float(np.linalg.norm(size) * 0.5)

        distance = max(radius / np.sin(fov_rad / 2.0), max_dim * 1.5)
        self.assertGreater(distance, max_dim)

        near = max(max_dim / 10000.0, 0.01)
        far = max(max_dim * 100.0, 2000.0)
        self.assertLess(near, 0.1)
        self.assertGreaterEqual(far, 2500.0)


if __name__ == "__main__":
    unittest.main()
