"""
SIH26158: Canonical Coordinate Systems and Geospatial Transformations.

Establishes mathematically rigorous coordinate conversions across the 4 pipeline frames:
1. LOCAL_SFM:      OpenCV / COLMAP camera convention (+X Right, +Y Down, +Z Forward)
2. LOCAL_METRIC:   Canonical metric drone frame (+X East/Right, +Y North/Forward, +Z Up in meters)
3. GEOREFERENCED:  Global WGS84 GPS (Lat, Lon, Alt) mapped via ECEF to local metric ENU
4. THREEJS:        Three.js WebGL rendering coordinate system (+X Right, +Y Up, +Z Backward)

Also provides:
- Umeyama metric similarity transform estimation (s, R, t)
- Coordinate bounds and diagnostic logging
- Point cloud validity sanity checks (NaN, Inf, absurd coords)
"""

from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional, Tuple, Union
import numpy as np


# WGS-84 Ellipsoid constants
WGS84_A = 6378137.0          # semi-major axis (meters)
WGS84_F = 1.0 / 298.257223563  # flattening
WGS84_B = WGS84_A * (1.0 - WGS84_F)  # semi-minor axis
WGS84_E2 = (WGS84_A**2 - WGS84_B**2) / (WGS84_A**2)  # first eccentricity squared


@dataclass
class ModelBounds:
    """Rigorous 3D bounding box, dimensions, center and diagonal diagnostics."""
    min_x: float
    max_x: float
    min_y: float
    max_y: float
    min_z: float
    max_z: float
    center_x: float
    center_y: float
    center_z: float
    width: float   # size_x
    height: float  # size_y
    depth: float   # size_z
    diagonal: float
    num_points: int
    coordinate_frame: str
    units: str = "meters"
    is_valid: bool = True
    error_message: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def log_summary(self, prefix: str = "MODEL_BOUNDS") -> str:
        """Formats the required MODEL_BOUNDS diagnostic log output."""
        return (
            f"[{prefix}]\n"
            f"frame = {self.coordinate_frame} ({self.units})\n"
            f"min = ({self.min_x:.4f}, {self.min_y:.4f}, {self.min_z:.4f})\n"
            f"max = ({self.max_x:.4f}, {self.max_y:.4f}, {self.max_z:.4f})\n"
            f"center = ({self.center_x:.4f}, {self.center_y:.4f}, {self.center_z:.4f})\n"
            f"size = ({self.width:.4f}, {self.height:.4f}, {self.depth:.4f})\n"
            f"diagonal = {self.diagonal:.4f} {self.units} (points: {self.num_points:,})"
        )


def compute_bounds_diagnostics(
    points: np.ndarray,
    coordinate_frame: str = "LOCAL_METRIC",
    max_reasonable_dim_m: float = 10000.0
) -> ModelBounds:
    """
    Computes exact bounding box, center, dimensions, diagonal, and checks coordinate sanity.
    Detects NaN, Inf, and absurd coordinates.
    """
    if points is None or len(points) == 0:
        return ModelBounds(
            min_x=0.0, max_x=0.0, min_y=0.0, max_y=0.0, min_z=0.0, max_z=0.0,
            center_x=0.0, center_y=0.0, center_z=0.0,
            width=0.0, height=0.0, depth=0.0, diagonal=0.0,
            num_points=0, coordinate_frame=coordinate_frame, is_valid=False,
            error_message="Empty point array"
        )

    # Sanity check: NaN and Inf detection
    finite_mask = np.isfinite(points).all(axis=1)
    if not np.all(finite_mask):
        valid_pts = points[finite_mask]
        if len(valid_pts) == 0:
            return ModelBounds(
                min_x=0.0, max_x=0.0, min_y=0.0, max_y=0.0, min_z=0.0, max_z=0.0,
                center_x=0.0, center_y=0.0, center_z=0.0,
                width=0.0, height=0.0, depth=0.0, diagonal=0.0,
                num_points=0, coordinate_frame=coordinate_frame, is_valid=False,
                error_message="All points contain NaN or Infinity"
            )
        points = valid_pts

    min_coords = np.min(points, axis=0)
    max_coords = np.max(points, axis=0)
    center = (min_coords + max_coords) / 2.0
    size = max_coords - min_coords
    diagonal = float(np.linalg.norm(size))

    is_valid = True
    error_msg = None

    # Detect absurd coordinates
    if diagonal > max_reasonable_dim_m:
        is_valid = False
        error_msg = f"Absurd bounding diagonal ({diagonal:.1f}m exceeds {max_reasonable_dim_m:.1f}m threshold)"
    elif diagonal < 1e-4:
        is_valid = False
        error_msg = f"Point cloud collapsed to a single point/zero volume (diagonal = {diagonal:.6f}m)"

    return ModelBounds(
        min_x=float(min_coords[0]),
        max_x=float(max_coords[0]),
        min_y=float(min_coords[1]),
        max_y=float(max_coords[1]),
        min_z=float(min_coords[2]),
        max_z=float(max_coords[2]),
        center_x=float(center[0]),
        center_y=float(center[1]),
        center_z=float(center[2]),
        width=float(size[0]),
        height=float(size[1]),
        depth=float(size[2]),
        diagonal=diagonal,
        num_points=len(points),
        coordinate_frame=coordinate_frame,
        is_valid=is_valid,
        error_message=error_msg
    )


# ---------------------------------------------------------------------------
# Coordinate Frame Transforms
# ---------------------------------------------------------------------------

def sfm_to_local_metric(
    points_sfm: np.ndarray,
    scale: float = 1.0,
    R_align: Optional[np.ndarray] = None,
    t_align: Optional[np.ndarray] = None
) -> np.ndarray:
    """
    Transforms points from raw OpenCV/COLMAP SfM space to canonical LOCAL_METRIC frame.
    In OpenCV/COLMAP camera space:
      +X: Right, +Y: Down, +Z: Forward
    In canonical LOCAL_METRIC frame:
      +X: East / Right
      +Y: North / Forward
      +Z: Up (zenith) in meters

    Standard conversion (when camera looks roughly horizontal or nadir):
      X_metric =  X_sfm
      Y_metric =  Z_sfm   (SfM forward becomes horizontal North/forward)
      Z_metric = -Y_sfm   (SfM down inverted becomes Up)

    If a full similarity transform (s, R, t) is provided, it is applied directly:
      P_metric = s * (R @ P_sfm) + t
    """
    if len(points_sfm) == 0:
        return np.empty((0, 3), dtype=np.float64)

    pts = np.asarray(points_sfm, dtype=np.float64)

    if R_align is not None and t_align is not None:
        # Full 7-DoF similarity transform
        t_vec = np.asarray(t_align, dtype=np.float64).reshape(3, 1)
        pts_trans = (scale * (R_align @ pts.T) + t_vec).T
        return pts_trans

    # Canonical base transformation matrix:
    # [ 1,  0,  0 ]
    # [ 0,  0,  1 ]
    # [ 0, -1,  0 ]
    T_sfm_to_metric = np.array([
        [1.0,  0.0,  0.0],
        [0.0,  0.0,  1.0],
        [0.0, -1.0,  0.0]
    ], dtype=np.float64)

    pts_metric = (T_sfm_to_metric @ (pts.T * scale)).T
    return pts_metric


def local_metric_to_threejs(points_metric: np.ndarray) -> np.ndarray:
    """
    Transforms points from canonical LOCAL_METRIC (+X East, +Y North, +Z Up)
    to Three.js WebGL rendering coordinate system (+X Right, +Y Up, +Z Backward).

    Mapping:
      X_three =  X_metric  (Right)
      Y_three =  Z_metric  (Up in Three.js is +Y)
      Z_three = -Y_metric  (North/forward in Three.js is -Z)
    """
    if len(points_metric) == 0:
        return np.empty((0, 3), dtype=np.float64)

    pts = np.asarray(points_metric, dtype=np.float64)
    T_metric_to_three = np.array([
        [1.0,  0.0,  0.0],
        [0.0,  0.0,  1.0],
        [0.0, -1.0,  0.0]
    ], dtype=np.float64)

    return (T_metric_to_three @ pts.T).T


def threejs_to_local_metric(points_three: np.ndarray) -> np.ndarray:
    """
    Inverse of local_metric_to_threejs:
      X_metric =  X_three
      Y_metric = -Z_three
      Z_metric =  Y_three
    """
    if len(points_three) == 0:
        return np.empty((0, 3), dtype=np.float64)

    pts = np.asarray(points_three, dtype=np.float64)
    T_three_to_metric = np.array([
        [1.0,  0.0,  0.0],
        [0.0,  0.0, -1.0],
        [0.0,  1.0,  0.0]
    ], dtype=np.float64)

    return (T_three_to_metric @ pts.T).T


# ---------------------------------------------------------------------------
# Geodetic (GPS WGS84) to ECEF and Local ENU
# ---------------------------------------------------------------------------

def geodetic_to_ecef(lat_deg: float, lon_deg: float, alt_m: float) -> Tuple[float, float, float]:
    """
    Converts WGS-84 Geodetic Coordinates (Lat, Lon in degrees, Alt in meters)
    to Earth-Centered Earth-Fixed (ECEF) X, Y, Z in meters.
    """
    lat_rad = np.deg2rad(lat_deg)
    lon_rad = np.deg2rad(lon_deg)

    sin_lat = np.sin(lat_rad)
    cos_lat = np.cos(lat_rad)
    sin_lon = np.sin(lon_rad)
    cos_lon = np.cos(lon_rad)

    # Prime vertical radius of curvature
    n = WGS84_A / np.sqrt(1.0 - WGS84_E2 * sin_lat**2)

    x = (n + alt_m) * cos_lat * cos_lon
    y = (n + alt_m) * cos_lat * sin_lon
    z = (n * (1.0 - WGS84_E2) + alt_m) * sin_lat

    return float(x), float(y), float(z)


def ecef_to_enu(
    x: float, y: float, z: float,
    ref_lat_deg: float, ref_lon_deg: float, ref_alt_m: float
) -> Tuple[float, float, float]:
    """
    Converts ECEF coordinates (x, y, z) in meters to local East-North-Up (ENU)
    coordinates in meters relative to reference point (ref_lat, ref_lon, ref_alt).
    """
    ref_x, ref_y, ref_z = geodetic_to_ecef(ref_lat_deg, ref_lon_deg, ref_alt_m)

    dx = x - ref_x
    dy = y - ref_y
    dz = z - ref_z

    lat_rad = np.deg2rad(ref_lat_deg)
    lon_rad = np.deg2rad(ref_lon_deg)

    sin_lat = np.sin(lat_rad)
    cos_lat = np.cos(lat_rad)
    sin_lon = np.sin(lon_rad)
    cos_lon = np.cos(lon_rad)

    # Rotation from ECEF to ENU
    east  = -sin_lon * dx + cos_lon * dy
    north = -sin_lat * cos_lon * dx - sin_lat * sin_lon * dy + cos_lat * dz
    up    =  cos_lat * cos_lon * dx + cos_lat * sin_lon * dy + sin_lat * dz

    return float(east), float(north), float(up)


def georeferenced_to_local_metric(
    lat_arr: Union[List[float], np.ndarray],
    lon_arr: Union[List[float], np.ndarray],
    alt_arr: Union[List[float], np.ndarray],
    ref_lat_deg: float,
    ref_lon_deg: float,
    ref_alt_m: float
) -> np.ndarray:
    """
    Converts an array of GPS geodetic coordinates to canonical LOCAL_METRIC frame
    (East, North, Up in meters relative to reference GPS point).
    NEVER uses raw latitude/longitude/altitude as XYZ.
    """
    lats = np.asarray(lat_arr, dtype=np.float64)
    lons = np.asarray(lon_arr, dtype=np.float64)
    alts = np.asarray(alt_arr, dtype=np.float64)

    n_pts = len(lats)
    enu_pts = np.zeros((n_pts, 3), dtype=np.float64)

    for i in range(n_pts):
        x_ecef, y_ecef, z_ecef = geodetic_to_ecef(lats[i], lons[i], alts[i])
        e, n, u = ecef_to_enu(x_ecef, y_ecef, z_ecef, ref_lat_deg, ref_lon_deg, ref_alt_m)
        enu_pts[i] = [e, n, u]

    return enu_pts


def local_metric_to_georeferenced(
    points_metric: np.ndarray,
    ref_lat_deg: float,
    ref_lon_deg: float,
    ref_alt_m: float
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Inverse conversion: transforms LOCAL_METRIC (East, North, Up in meters)
    back to WGS-84 Geodetic Coordinates (Lat, Lon in deg, Alt in m).
    """
    ref_x, ref_y, ref_z = geodetic_to_ecef(ref_lat_deg, ref_lon_deg, ref_alt_m)

    lat_rad = np.deg2rad(ref_lat_deg)
    lon_rad = np.deg2rad(ref_lon_deg)
    sin_lat = np.sin(lat_rad)
    cos_lat = np.cos(lat_rad)
    sin_lon = np.sin(lon_rad)
    cos_lon = np.cos(lon_rad)

    # Inverse ENU to ECEF rotation matrix
    # [dx, dy, dz]^T = R_enu_to_ecef @ [e, n, u]^T
    R_enu_to_ecef = np.array([
        [-sin_lon, -sin_lat * cos_lon, cos_lat * cos_lon],
        [ cos_lon, -sin_lat * sin_lon, cos_lat * sin_lon],
        [     0.0,            cos_lat,           sin_lat]
    ], dtype=np.float64)

    pts = np.asarray(points_metric, dtype=np.float64)
    d_ecef = (R_enu_to_ecef @ pts.T).T
    ecef_pts = d_ecef + np.array([ref_x, ref_y, ref_z], dtype=np.float64)

    # ECEF to Geodetic via Bowring's method
    out_lat = np.zeros(len(pts))
    out_lon = np.zeros(len(pts))
    out_alt = np.zeros(len(pts))

    for i in range(len(pts)):
        x, y, z = ecef_pts[i]
        p = np.sqrt(x**2 + y**2)
        theta = np.arctan2(z * WGS84_A, p * WGS84_B)
        e_prime2 = (WGS84_A**2 - WGS84_B**2) / (WGS84_B**2)

        lat = np.arctan2(
            z + e_prime2 * WGS84_B * np.sin(theta)**3,
            p - WGS84_E2 * WGS84_A * np.cos(theta)**3
        )
        lon = np.arctan2(y, x)
        n = WGS84_A / np.sqrt(1.0 - WGS84_E2 * np.sin(lat)**2)
        alt = p / np.cos(lat) - n

        out_lat[i] = np.rad2deg(lat)
        out_lon[i] = np.rad2deg(lon)
        out_alt[i] = alt

    return out_lat, out_lon, out_alt


# ---------------------------------------------------------------------------
# 7-DoF Similarity Transform (Umeyama Algorithm)
# ---------------------------------------------------------------------------

def estimate_similarity_transform(
    src_points: np.ndarray,
    dst_points: np.ndarray
) -> Tuple[float, np.ndarray, np.ndarray]:
    """
    Estimates the optimal 7-DoF similarity transformation (scale s, rotation R, translation t)
    aligning src_points to dst_points such that:
      dst ≈ s * R @ src + t
    Uses the classical Umeyama algorithm with SVD.

    Returns:
      (scale, R, t) where scale is float, R is (3, 3), t is (3, 1)
    """
    src = np.asarray(src_points, dtype=np.float64)
    dst = np.asarray(dst_points, dtype=np.float64)

    if len(src) < 3 or len(dst) < 3:
        raise ValueError("Similarity transformation requires at least 3 non-collinear point correspondences.")

    n, m = src.shape
    if m != 3:
        raise ValueError(f"Points must be 3D (Nx3), got shape {src.shape}")

    # Compute centroids
    src_mean = np.mean(src, axis=0)
    dst_mean = np.mean(dst, axis=0)

    src_centered = src - src_mean
    dst_centered = dst - dst_mean

    # Variances
    src_var = float(np.sum(src_centered**2) / n)

    if src_var < 1e-12:
        return 1.0, np.eye(3), (dst_mean - src_mean).reshape(3, 1)

    # Covariance matrix H = dst^T @ src / n
    H = (dst_centered.T @ src_centered) / n

    # SVD
    U, S, Vt = np.linalg.svd(H)

    # Reflection check
    d = np.linalg.det(U @ Vt)
    D = np.eye(3)
    if d < 0:
        D[2, 2] = -1.0

    R = U @ D @ Vt
    scale = float(np.trace(np.diag(S) @ D) / src_var)
    t = (dst_mean - scale * (R @ src_mean)).reshape(3, 1)

    return scale, R, t
