"""
Point Cloud Fusion and Pinhole 3D Unprojection.
Transforms 2D depth and color maps into registered 3D world coordinates.
Applies canonical coordinate transformations (LOCAL_SFM -> LOCAL_METRIC -> THREEJS)
and rigorous sanity checks (NaN/Inf purging, outlier bounds).
"""

from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
import cv2
import numpy as np

from reconstruction.geospatial.coordinates import (
    ModelBounds,
    compute_bounds_diagnostics,
    sfm_to_local_metric,
    local_metric_to_threejs
)


class PointCloudFuser:
    """
    Fuses multi-frame depth maps into a unified, metric 3D point cloud.
    Guarantees coordinate consistency and purges non-finite / absurd values.
    """
    def __init__(self, voxel_size: float = 0.04, min_confidence: float = 0.15):
        self.voxel_size = voxel_size
        self.min_confidence = min_confidence

    def unproject_depth(
        self,
        depth_map: np.ndarray,
        rgb_image: np.ndarray,
        K: np.ndarray,
        R: np.ndarray,
        t: np.ndarray,
        confidence_map: Optional[np.ndarray] = None,
        stride: int = 2
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Unprojects a 2D depth map to 3D world coordinates using camera intrinsics K and pose (R, t).
        Returns: (points_3d, colors_rgb) in LOCAL_SFM frame.
        """
        if R is None or t is None:
            return np.empty((0, 3), dtype=np.float64), np.empty((0, 3), dtype=np.uint8)

        h_d, w_d = depth_map.shape[:2]
        h_img, w_img = rgb_image.shape[:2]

        # Rescale intrinsics to depth map resolution
        scale_x = w_d / float(w_img)
        scale_y = h_d / float(h_img)
        fx = K[0, 0] * scale_x
        fy = K[1, 1] * scale_y
        cx = K[0, 2] * scale_x
        cy = K[1, 2] * scale_y

        # Subsample grid for performance & memory bounding
        u = np.arange(0, w_d, stride)
        v = np.arange(0, h_d, stride)
        uu, vv = np.meshgrid(u, v)

        z = depth_map[vv, uu]
        valid_mask = (z > 0.2) & (z < 120.0)

        if confidence_map is not None:
            conf = confidence_map[vv, uu]
            valid_mask &= (conf >= self.min_confidence)

        uu_valid = uu[valid_mask]
        vv_valid = vv[valid_mask]
        z_valid = z[valid_mask]

        if len(z_valid) == 0:
            return np.empty((0, 3), dtype=np.float64), np.empty((0, 3), dtype=np.uint8)

        # Pinhole Back-projection:
        # X_cam = (u - cx) * Z / fx
        # Y_cam = (v - cy) * Z / fy
        # Z_cam = Z
        x_cam = (uu_valid - cx) * z_valid / fx
        y_cam = (vv_valid - cy) * z_valid / fy
        pts_cam = np.stack([x_cam, y_cam, z_valid], axis=1)  # (N, 3)

        # World Coordinate Transformation: P_world = R^T * (P_cam - t)
        # In COLMAP / OpenCV convention: P_cam = R * P_world + t
        # Therefore: P_world = R^T * (P_cam - t)
        t_vec = np.asarray(t).reshape(3, 1)
        R_mat = np.asarray(R)
        pts_world = (R_mat.T @ (pts_cam.T - t_vec)).T

        # Sample RGB colors from image
        rgb_resized = cv2.resize(rgb_image, (w_d, h_d), interpolation=cv2.INTER_AREA)
        colors_bgr = rgb_resized[vv_valid, uu_valid]
        colors_rgb = colors_bgr[:, [2, 1, 0]]  # BGR to RGB

        # Purge any non-finite points
        finite_idx = np.isfinite(pts_world).all(axis=1)
        return pts_world[finite_idx], colors_rgb[finite_idx]

    def voxel_downsample(self, points: np.ndarray, colors: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        """
        Voxel grid downsampling via integer spatial hashing.
        """
        if len(points) == 0:
            return points, colors

        voxel_coords = np.floor(points / self.voxel_size).astype(np.int64)
        
        # Unique voxel hash map
        _, unique_indices = np.unique(voxel_coords, axis=0, return_index=True)
        return points[unique_indices], colors[unique_indices]

    def remove_outliers(
        self,
        points: np.ndarray,
        colors: np.ndarray,
        k_std: float = 2.2,
        max_abs_extent: float = 500.0
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Removes statistical distance outliers and absurd coordinates from the point cloud.
        """
        if len(points) < 50:
            return points, colors

        # Purge points beyond realistic bounding box for a drone site
        finite_mask = np.isfinite(points).all(axis=1)
        finite_pts = points[finite_mask]
        finite_cols = colors[finite_mask]

        if len(finite_pts) < 50:
            return finite_pts, finite_cols

        # Bounding extent filter
        centroid = np.median(finite_pts, axis=0)
        extent_mask = np.all(np.abs(finite_pts - centroid) < max_abs_extent, axis=1)
        filtered_pts = finite_pts[extent_mask]
        filtered_cols = finite_cols[extent_mask]

        if len(filtered_pts) < 50:
            return filtered_pts, filtered_cols

        # Statistical distance filter
        distances = np.linalg.norm(filtered_pts - centroid, axis=1)
        mean_dist = np.mean(distances)
        std_dist = np.std(distances)

        inlier_mask = distances < (mean_dist + k_std * std_dist)
        return filtered_pts[inlier_mask], filtered_cols[inlier_mask]

    def log_diagnostics(self, points: np.ndarray, label: str = "LOCAL_METRIC") -> ModelBounds:
        """
        Calculates and prints the exact MODEL_BOUNDS diagnostics required by Phase 2.
        """
        bounds = compute_bounds_diagnostics(points, coordinate_frame=label)
        print(bounds.log_summary(prefix="MODEL_BOUNDS"))
        return bounds

    def export_ply(self, points: np.ndarray, colors: np.ndarray, output_path: Path) -> Path:
        """
        Saves point cloud to standard PLY format.
        """
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        n = len(points)
        header = f"""ply
format ascii 1.0
element vertex {n}
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
end_header
"""
        with open(output_path, "w", encoding="ascii") as f:
            f.write(header)
            for i in range(n):
                p = points[i]
                c = colors[i]
                f.write(f"{p[0]:.4f} {p[1]:.4f} {p[2]:.4f} {int(c[0])} {int(c[1])} {int(c[2])}\n")

        return output_path
