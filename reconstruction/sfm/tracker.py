"""
Structure-from-Motion (SfM) Tracker.
Extracts feature correspondences, computes camera poses via Essential Matrix RANSAC,
and triangulates sparse 3D landmarks.
"""

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import cv2
import numpy as np


@dataclass
class CameraPose:
    """Represents an estimated camera pose in world coordinates."""
    frame_id: int
    filename: str
    rotation: List[List[float]]       # 3x3 rotation matrix R
    translation: List[float]          # 3x1 translation vector t
    camera_center: List[float]        # -R^T * t
    inliers_count: int
    registered: bool

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class SfMTracker:
    """
    Local Structure-from-Motion engine using OpenCV SIFT/ORB features and Essential Matrix RANSAC.
    """
    def __init__(
        self,
        focal_length_px: Optional[float] = None,
        max_features: int = 2000,
        processing_width: int = 1280
    ):
        self.focal_length = focal_length_px
        self.max_features = max_features
        self.processing_width = processing_width
        
        # Use SIFT if available (standard in opencv-contrib), fallback to ORB
        try:
            self.detector = cv2.SIFT_create(nfeatures=self.max_features)
            self.norm_type = cv2.NORM_L2
            self.use_flann = True
        except Exception:
            self.detector = cv2.ORB_create(nfeatures=self.max_features)
            self.norm_type = cv2.NORM_HAMMING
            self.use_flann = False

    def estimate_intrinsics(self, width: int, height: int) -> np.ndarray:
        """
        Estimate camera calibration matrix K assuming standard drone FOV (~84 degrees).
        K = [[fx,  0, cx],
             [ 0, fy, cy],
             [ 0,  0,  1]]
        """
        if self.focal_length is not None:
            fx = fy = self.focal_length
        else:
            # Approximate fx from 84 degree horizontal field of view
            fov_rad = np.deg2rad(84.0)
            fx = (width / 2.0) / np.tan(fov_rad / 2.0)
            fy = fx
            
        cx = width / 2.0
        cy = height / 2.0
        
        return np.array([
            [fx, 0.0, cx],
            [0.0, fy, cy],
            [0.0, 0.0, 1.0]
        ], dtype=np.float64)

    def extract_features(self, image_bgr: np.ndarray) -> Tuple[List[cv2.KeyPoint], np.ndarray, float]:
        """Downsamples image for SfM feature detection and extracts descriptors."""
        h, w = image_bgr.shape[:2]
        scale = 1.0
        if w > self.processing_width:
            scale = self.processing_width / float(w)
            new_w = int(w * scale)
            new_h = int(h * scale)
            image_bgr = cv2.resize(image_bgr, (new_w, new_h), interpolation=cv2.INTER_AREA)
            
        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        keypoints, descriptors = self.detector.detectAndCompute(gray, None)
        return keypoints, descriptors, scale

    def match_features(self, desc1: np.ndarray, desc2: np.ndarray) -> List[cv2.DMatch]:
        """Matches descriptors using Lowe's ratio test (0.75)."""
        if desc1 is None or desc2 is None or len(desc1) < 8 or len(desc2) < 8:
            return []
            
        if self.use_flann:
            FLANN_INDEX_KDTREE = 1
            index_params = dict(algorithm=FLANN_INDEX_KDTREE, trees=5)
            search_params = dict(checks=50)
            matcher = cv2.FlannBasedMatcher(index_params, search_params)
        else:
            matcher = cv2.BFMatcher(self.norm_type, crossCheck=False)
            
        try:
            knn_matches = matcher.knnMatch(desc1, desc2, k=2)
        except Exception:
            return []
            
        good_matches = []
        for match_pair in knn_matches:
            if len(match_pair) == 2:
                m, n = match_pair
                if m.distance < 0.75 * n.distance:
                    good_matches.append(m)
                    
        return good_matches

    def run(self, keyframe_paths: List[Path]) -> Tuple[List[CameraPose], np.ndarray]:
        """
        Processes keyframe images in sequence and recovers relative camera poses.
        Returns: (poses_list, sparse_3d_points)
        """
        if len(keyframe_paths) < 2:
            raise ValueError("SfM requires at least 2 keyframes to compute relative motion.")

        # Read first frame to estimate intrinsics
        sample_img = cv2.imread(str(keyframe_paths[0]))
        if sample_img is None:
            raise ValueError(f"Could not read keyframe: {keyframe_paths[0]}")
            
        h, w = sample_img.shape[:2]
        K = self.estimate_intrinsics(w, h)

        poses: List[CameraPose] = []
        sparse_points: List[np.ndarray] = []

        # Pose 0: World Origin [I | 0]
        R_current = np.eye(3, dtype=np.float64)
        t_current = np.zeros((3, 1), dtype=np.float64)

        poses.append(CameraPose(
            frame_id=0,
            filename=keyframe_paths[0].name,
            rotation=R_current.tolist(),
            translation=t_current.flatten().tolist(),
            camera_center=[0.0, 0.0, 0.0],
            inliers_count=0,
            registered=True
        ))

        # Extract features for all keyframes
        features = []
        for p in keyframe_paths:
            img = cv2.imread(str(p))
            kp, desc, scale = self.extract_features(img)
            features.append((kp, desc, scale))

        # Sequential pairwise registration
        for i in range(len(keyframe_paths) - 1):
            kp1, desc1, s1 = features[i]
            kp2, desc2, s2 = features[i + 1]

            matches = self.match_features(desc1, desc2)

            if len(matches) < 15:
                # Poor overlap, record unregistered or extrapolated pose
                poses.append(CameraPose(
                    frame_id=i + 1,
                    filename=keyframe_paths[i + 1].name,
                    rotation=R_current.tolist(),
                    translation=t_current.flatten().tolist(),
                    camera_center=(-R_current.T @ t_current).flatten().tolist(),
                    inliers_count=len(matches),
                    registered=False
                ))
                continue

            pts1 = np.float32([kp1[m.queryIdx].pt for m in matches]) / s1
            pts2 = np.float32([kp2[m.trainIdx].pt for m in matches]) / s2

            # Essential Matrix RANSAC
            E, mask = cv2.findEssentialMat(pts1, pts2, K, method=cv2.RANSAC, prob=0.999, threshold=1.0)

            if E is None or mask is None:
                inliers = 0
                R_rel = np.eye(3)
                t_rel = np.array([[0.0], [0.0], [0.1]])
            else:
                inliers = int(np.sum(mask))
                _, R_rel, t_rel, mask_pose = cv2.recoverPose(E, pts1, pts2, K, mask=mask)

            # Accumulate pose: P_world = R_rel * P_prev + t_rel
            t_current = t_current + R_current @ t_rel
            R_current = R_rel @ R_current
            cam_center = -R_current.T @ t_current

            is_reg = bool(inliers >= 12)
            poses.append(CameraPose(
                frame_id=i + 1,
                filename=keyframe_paths[i + 1].name,
                rotation=R_current.tolist() if is_reg else None,
                translation=t_current.flatten().tolist() if is_reg else None,
                camera_center=cam_center.flatten().tolist() if is_reg else None,
                inliers_count=inliers,
                registered=is_reg
            ))

            # Triangulate points for inliers
            if inliers >= 12 and mask_pose is not None:
                inlier_idx = np.where(mask_pose.flatten() > 0)[0]
                if len(inlier_idx) > 0:
                    pts1_in = pts1[inlier_idx].T
                    pts2_in = pts2[inlier_idx].T

                    P1 = K @ np.hstack((np.eye(3), np.zeros((3, 1))))
                    P2 = K @ np.hstack((R_rel, t_rel))

                    pts4d = cv2.triangulatePoints(P1, P2, pts1_in, pts2_in)
                    pts3d = (pts4d[:3] / pts4d[3]).T  # Homogeneous to 3D Euclidean

                    # Transform triangulated points to world coordinate frame
                    for pt in pts3d:
                        if 0.1 < pt[2] < 100.0:  # Valid positive depth
                            pt_world = R_current.T @ (pt.reshape(3, 1) - t_current)
                            sparse_points.append(pt_world.flatten())

        sparse_pts_arr = np.array(sparse_points) if sparse_points else np.empty((0, 3))
        
        # Phase 6 validation
        from reconstruction.colmap.pipeline import validate_sfm_results
        reg_count = sum(1 for p in poses if p.registered)
        val = validate_sfm_results(reg_count, len(keyframe_paths), len(sparse_pts_arr))
        return poses, sparse_pts_arr, val
