"""
COLMAP Reconstruction Pipeline.
Wraps pycolmap and COLMAP CLI to perform industrial-grade SIFT feature extraction,
geometric verification, bundle adjustment, and camera pose registration.
Enforces Phase 6 strict validation rules.
"""

from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
import numpy as np

try:
    import pycolmap as _pycolmap
    pycolmap: Any = _pycolmap
    HAS_PYCOLMAP = True
except ImportError:
    pycolmap: Any = None
    HAS_PYCOLMAP = False


def is_colmap_available() -> bool:
    """Checks if pycolmap or local colmap binary is available."""
    return HAS_PYCOLMAP


def validate_sfm_results(
    registered_count: int,
    total_count: int,
    sparse_points_count: int,
    min_registered: int = 5,
    min_sparse_pts: int = 50
) -> Dict[str, Any]:
    """
    Phase 6 Validation Rules:
      registered < 5 or sparse_points < 50 => FAIL
      registered between 5 and 10 => WEAK / WARNING
      registered between 11 and 17 => MODERATE
      registered between 18 and 21 => GOOD
      registered >= 22 => EXCELLENT
    """
    if registered_count < min_registered or sparse_points_count < min_sparse_pts:
        return {
            "status": "FAILED_SFM",
            "registered_images": registered_count,
            "total_images": total_count,
            "sparse_points": sparse_points_count,
            "metric_ready": False,
            "confidence": "FAILED",
            "message": (
                f"COLMAP registered only {registered_count}/{total_count} images "
                f"and {sparse_points_count} points (minimum required: {min_registered} images, {min_sparse_pts} points)."
            )
        }
    elif registered_count < 11:
        return {
            "status": "WEAK",
            "registered_images": registered_count,
            "total_images": total_count,
            "sparse_points": sparse_points_count,
            "metric_ready": True,
            "confidence": "LOW",
            "message": f"COLMAP registration is weak ({registered_count}/{total_count} images, {sparse_points_count} points)."
        }
    elif registered_count < 18:
        return {
            "status": "MODERATE",
            "registered_images": registered_count,
            "total_images": total_count,
            "sparse_points": sparse_points_count,
            "metric_ready": True,
            "confidence": "MEDIUM",
            "message": f"COLMAP registered {registered_count}/{total_count} images with {sparse_points_count} points."
        }
    elif registered_count < 22:
        return {
            "status": "GOOD",
            "registered_images": registered_count,
            "total_images": total_count,
            "sparse_points": sparse_points_count,
            "metric_ready": True,
            "confidence": "HIGH",
            "message": f"COLMAP registered {registered_count}/{total_count} images with {sparse_points_count} points."
        }
    else:
        return {
            "status": "EXCELLENT",
            "registered_images": registered_count,
            "total_images": total_count,
            "sparse_points": sparse_points_count,
            "metric_ready": True,
            "confidence": "HIGH",
            "message": f"COLMAP registered {registered_count}/{total_count} images with {sparse_points_count} points."
        }


class ColmapPipeline:
    """
    Executes COLMAP Structure-from-Motion on extracted drone keyframes.
    Extracts camera poses (R, t) and sparse 3D point clouds with rigorous validation.
    """
    def __init__(
        self,
        max_image_size: int = 1280,
        max_num_features: int = 2500,
        use_gpu: bool = False
    ):
        self.max_image_size = max_image_size
        self.max_num_features = max_num_features
        self.use_gpu = use_gpu
        self.last_validation: Optional[Dict[str, Any]] = None

    def run(
        self,
        keyframe_paths: List[Path],
        output_dir: Path
    ) -> Tuple[List[Dict[str, Any]], np.ndarray, Dict[str, Any]]:
        """
        Executes feature extraction, matching, and incremental mapping.
        Returns: (poses_list, sparse_points_3d, validation_dict)
        """
        if not HAS_PYCOLMAP:
            raise RuntimeError("pycolmap is not installed. Install with 'pip install pycolmap'.")

        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        database_path = output_dir / "database.db"
        sparse_dir = output_dir / "sparse"
        sparse_dir.mkdir(parents=True, exist_ok=True)

        if database_path.exists():
            try:
                database_path.unlink()
            except Exception:
                pass

        image_dir = keyframe_paths[0].parent
        image_names = [p.name for p in keyframe_paths]

        print(f"[COLMAP] Extracting SIFT features for {len(image_names)} keyframes...")
        ext_opts: Any = pycolmap.FeatureExtractionOptions()
        try:
            ext_opts.max_image_size = self.max_image_size
        except AttributeError:
            pass
        try:
            ext_opts.sift.max_num_features = self.max_num_features
        except AttributeError:
            try:
                ext_opts.SiftExtractionOptions.max_num_features = self.max_num_features
            except AttributeError:
                pass

        # Single camera mode: drone camera intrinsics are shared across all frames
        pycolmap.extract_features(
            database_path,
            image_dir,
            image_names=image_names,
            camera_mode=pycolmap.CameraMode.SINGLE,
            extraction_options=ext_opts
        )

        print("[COLMAP] Running feature matching & two-view geometric verification...")
        ver_opts: Any = pycolmap.TwoViewGeometryOptions()
        try:
            ver_opts.compute_relative_pose = True
            ver_opts.max_H_inlier_ratio = 0.98
            ver_opts.min_E_F_inlier_ratio = 0.05
        except AttributeError:
            pass

        pycolmap.match_exhaustive(
            database_path,
            verification_options=ver_opts
        )

        print("[COLMAP] Running incremental mapping (optimized for drone trajectories)...")
        inc_opts = pycolmap.IncrementalPipelineOptions()
        # Drone forward flight & small baseline tuning
        inc_opts.mapper.init_min_tri_angle = 1.5
        inc_opts.mapper.init_max_forward_motion = 0.999
        inc_opts.mapper.init_max_error = 8.0
        inc_opts.mapper.init_min_num_inliers = 15
        inc_opts.mapper.init_max_reg_trials = 300
        inc_opts.mapper.filter_min_tri_angle = 0.5
        inc_opts.mapper.filter_max_reproj_error = 8.0
        inc_opts.mapper.abs_pose_max_error = 12.0
        inc_opts.mapper.abs_pose_min_num_inliers = 15

        reconstructions = pycolmap.incremental_mapping(
            database_path,
            image_dir,
            sparse_dir,
            options=inc_opts
        )

        if not reconstructions or len(reconstructions) == 0:
            print("[COLMAP] Warning: COLMAP found no non-degenerate initial pair for sparse bundle adjustment.")
            val = validate_sfm_results(0, len(image_names), 0)
            self.last_validation = val
            poses = [
                {
                    "frame_id": idx + 1,
                    "filename": kf_path.name,
                    "rotation": None,
                    "translation": None,
                    "camera_center": None,
                    "inliers_count": 0,
                    "registered": False
                }
                for idx, kf_path in enumerate(keyframe_paths)
            ]
            return poses, np.empty((0, 3)), val

        # Select the reconstruction with the most registered images
        best_model = max(reconstructions.values(), key=lambda r: len(r.images))
        num_registered = len(best_model.images)
        num_sparse_pts = len(best_model.points3D)

        # Validate against strict threshold rules
        val = validate_sfm_results(num_registered, len(image_names), num_sparse_pts)
        self.last_validation = val

        print(f"[COLMAP] SfM Model Evaluation: {num_registered}/{len(image_names)} registered images, {num_sparse_pts} 3D points.")
        print(f"[COLMAP] Validation Status: {val['status']} (Confidence: {val['confidence']}) - {val['message']}")

        # Extract camera poses
        poses = []
        name_to_id = {img.name: img_id for img_id, img in best_model.images.items()}

        for idx, kf_path in enumerate(keyframe_paths):
            fname = kf_path.name
            if fname in name_to_id:
                img_obj = best_model.images[name_to_id[fname]]
                cam_from_world: Any = img_obj.cam_from_world() if callable(img_obj.cam_from_world) else img_obj.cam_from_world
                R = cam_from_world.rotation.matrix()
                t = cam_from_world.translation
                center = -R.T @ t

                poses.append({
                    "frame_id": idx + 1,
                    "filename": fname,
                    "rotation": R.tolist(),
                    "translation": t.tolist(),
                    "camera_center": center.tolist(),
                    "inliers_count": len(img_obj.points2D),
                    "registered": True
                })
            else:
                # Strictly DO NOT fake an identity pose for unregistered images
                poses.append({
                    "frame_id": idx + 1,
                    "filename": fname,
                    "rotation": None,
                    "translation": None,
                    "camera_center": None,
                    "inliers_count": 0,
                    "registered": False
                })

        # Extract 3D points
        sparse_points = []
        for pt3d in best_model.points3D.values():
            sparse_points.append(pt3d.xyz)

        pts_array = np.array(sparse_points) if sparse_points else np.empty((0, 3))
        return poses, pts_array, val
