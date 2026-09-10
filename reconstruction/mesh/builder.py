import json
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
import numpy as np
from scipy.spatial import Delaunay
import trimesh

from reconstruction.geospatial.coordinates import (
    ModelBounds,
    compute_bounds_diagnostics
)


class MeshBuilder:
    """
    Constructs surface meshes, colored OBJ, and binary GLB assets from 3D point clouds.
    Optimized for aerial drone trajectories and browser Three.js rendering.
    Calculates exact model bounds and exports metadata for the web viewer.
    """
    def __init__(self, target_faces: int = 50000, max_points: int = 80000):
        self.target_faces = target_faces
        self.max_points = max_points

    def build_surface_triangulation(
        self,
        points: np.ndarray,
        colors: np.ndarray,
        max_edge_factor: float = 2.5
    ) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        """
        Performs 2.5D Delaunay triangulation projected onto the dominant ground plane (PCA).
        Subsamples to max_points before triangulation to keep output file sizes manageable.
        Filters out stretched triangles spanning across gaps.
        Returns: (points, colors, faces)
        """
        if len(points) < 4:
            raise ValueError(f"Insufficient points ({len(points)}) for surface triangulation.")

        # ---- Subsample to cap vertex/face count before Delaunay ----
        if len(points) > self.max_points:
            rng = np.random.default_rng(42)
            idx = rng.choice(len(points), size=self.max_points, replace=False)
            idx.sort()
            points = points[idx]
            colors = colors[idx]
            print(f"[MeshBuilder] Subsampled point cloud to {self.max_points:,} points for triangulation.")

        # 1. PCA alignment to find dominant projection plane
        centroid = np.mean(points, axis=0)
        pts_centered = points - centroid
        cov = np.cov(pts_centered, rowvar=False)
        eigenvalues, eigenvectors = np.linalg.eigh(cov)

        # Sort eigenvectors by variance (descending)
        order = np.argsort(eigenvalues)[::-1]
        plane_u = eigenvectors[:, order[0]]
        plane_v = eigenvectors[:, order[1]]

        # Project 3D points onto 2D plane coordinates
        u_coords = pts_centered @ plane_u
        v_coords = pts_centered @ plane_v
        pts_2d = np.stack([u_coords, v_coords], axis=1)

        # 2. Delaunay 2D Triangulation
        tri = Delaunay(pts_2d)
        simplices = tri.simplices

        # 3. Filter long edges to prevent bridging over voids
        p0 = points[simplices[:, 0]]
        p1 = points[simplices[:, 1]]
        p2 = points[simplices[:, 2]]

        e01 = np.linalg.norm(p0 - p1, axis=1)
        e12 = np.linalg.norm(p1 - p2, axis=1)
        e20 = np.linalg.norm(p2 - p0, axis=1)
        max_edges = np.maximum(e01, np.maximum(e12, e20))

        median_edge = np.median(max_edges)
        valid_mask = max_edges < (median_edge * max_edge_factor)
        valid_faces = simplices[valid_mask]

        return points, colors, valid_faces

    def export_colored_obj(
        self,
        points: np.ndarray,
        colors: np.ndarray,
        faces: np.ndarray,
        output_path: Path
    ) -> Path:
        """
        Exports 3D mesh with per-vertex RGB colors (v x y z r g b), smooth normals (vn nx ny nz),
        and faces (f v1//vn1 v2//vn2 v3//vn3).
        Three.js OBJLoader natively renders smooth shaded colored meshes with normals.
        """
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # Ensure colors are uint8 in [0, 255]
        if colors.dtype != np.uint8 and np.max(colors) <= 1.0:
            colors = (colors * 255).astype(np.uint8)

        # Normalize colors to [0.0, 1.0] for standard Three.js OBJLoader
        norm_colors = colors.astype(np.float32) / 255.0

        # Calculate smooth per-vertex normals
        v_normals = np.zeros_like(points, dtype=np.float32)
        if len(faces) > 0:
            p0 = points[faces[:, 0]]
            p1 = points[faces[:, 1]]
            p2 = points[faces[:, 2]]
            f_normals = np.cross(p1 - p0, p2 - p0)
            f_norm_len = np.linalg.norm(f_normals, axis=1, keepdims=True)
            f_normals = f_normals / np.maximum(f_norm_len, 1e-8)

            for i in range(3):
                np.add.at(v_normals, faces[:, i], f_normals)

            v_norm_len = np.linalg.norm(v_normals, axis=1, keepdims=True)
            v_normals = v_normals / np.maximum(v_norm_len, 1e-8)
        else:
            v_normals[:, 2] = 1.0

        with open(output_path, "w", encoding="utf-8") as f:
            f.write("# SIH26158 High-Detail Drone 3D Reconstruction Model\n")
            f.write(f"# Vertices: {len(points)}, Faces: {len(faces)}\n")

            # Write vertices with colors: v x y z r g b
            for i in range(len(points)):
                p = points[i]
                c = norm_colors[i]
                f.write(f"v {p[0]:.4f} {p[1]:.4f} {p[2]:.4f} {c[0]:.4f} {c[1]:.4f} {c[2]:.4f}\n")

            # Write vertex normals: vn nx ny nz
            for i in range(len(v_normals)):
                vn = v_normals[i]
                f.write(f"vn {vn[0]:.4f} {vn[1]:.4f} {vn[2]:.4f}\n")

            # Write faces with normal indices: f v1//vn1 v2//vn2 v3//vn3
            for face in faces:
                v1, v2, v3 = face[0] + 1, face[1] + 1, face[2] + 1
                f.write(f"f {v1}//{v1} {v2}//{v2} {v3}//{v3}\n")

        return output_path

    def export_glb(
        self,
        points: np.ndarray,
        colors: np.ndarray,
        faces: np.ndarray,
        glb_path: Path
    ) -> Optional[Path]:
        """
        Exports mesh as binary GLB (GLTF 2.0).
        Applies quadric decimation when the fast-simplification backend is available.
        GLB files are 5–20x smaller than equivalent OBJ text files.
        """
        glb_path = Path(glb_path)
        glb_path.parent.mkdir(parents=True, exist_ok=True)

        # Ensure uint8 vertex colors [0, 255]
        if colors.dtype != np.uint8 and np.max(colors) <= 1.0:
            colors = (colors * 255).astype(np.uint8)

        try:
            mesh = trimesh.Trimesh(
                vertices=points,
                faces=faces,
                vertex_colors=colors,
                process=False
            )

            # Attempt quality decimation
            if len(faces) > self.target_faces:
                try:
                    mesh = mesh.simplify_quadric_decimation(face_count=self.target_faces)
                    print(f"[MeshBuilder] Decimated mesh to {len(mesh.faces):,} faces (target {self.target_faces:,}).")
                except Exception as dec_err:
                    print(f"[MeshBuilder] Decimation skipped ({dec_err}); using full mesh.")

            mesh.export(str(glb_path), file_type="glb")
            size_mb = glb_path.stat().st_size / (1024 * 1024)
            print(f"[MeshBuilder] Exported GLB: {glb_path} ({size_mb:.1f} MB)")
            return glb_path
        except Exception as e:
            print(f"[MeshBuilder] GLB export failed: {e}")
            return None

    def build_and_export(
        self,
        points: np.ndarray,
        colors: np.ndarray,
        obj_path: Path,
        glb_path: Optional[Path] = None,
        coordinate_frame: str = "THREEJS",
        extra_metadata: Optional[Dict[str, Any]] = None
    ) -> Tuple[Path, Optional[Path], Path, ModelBounds]:
        """
        Orchestrates surface triangulation, colored OBJ export, GLB export,
        and saves model_metadata.json with exact bounding diagnostics.
        """
        pts, cols, faces = self.build_surface_triangulation(points, colors)
        exported_obj = self.export_colored_obj(pts, cols, faces, obj_path)

        if glb_path is None:
            glb_path = Path(obj_path).with_suffix(".glb")

        exported_glb = self.export_glb(pts, cols, faces, glb_path)

        # Compute diagnostic bounds
        bounds = compute_bounds_diagnostics(pts, coordinate_frame=coordinate_frame)
        print(bounds.log_summary(prefix="MODEL_BOUNDS"))

        # Write model_metadata.json
        meta_path = Path(obj_path).parent / "model_metadata.json"
        meta_dict = {
            "coordinate_system": coordinate_frame,
            "units": bounds.units,
            "bounds": bounds.to_dict(),
            "stats": {
                "vertices": len(pts),
                "faces": len(faces)
            }
        }
        if extra_metadata:
            meta_dict.update(extra_metadata)

        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta_dict, f, indent=2)

        return exported_obj, exported_glb, meta_path, bounds
