"""
SIH26158: Single-Pass Drone Video to Accurate 3D Model Generation System
Master Reconstruction CLI Entrypoint.
Orchestrates:
1. Milestone 1: Keyframe extraction & quality filtering
2. Milestone 2: Structure-from-Motion (SfM) camera tracking with strict validation
3. Milestone 3: Dense depth estimation, confidence mapping, and depth analysis
4. Milestone 4: Multi-view pinhole unprojection, pose validation, & canonical coordinate fusion
5. Milestone 5: 2.5D surface triangulation & colored Wavefront OBJ + GLB generation
6. Stage 6: Asset synchronization with local web viewer and diagnostic metadata
"""

import argparse
import json
import shutil
import sys
import time
from pathlib import Path
import cv2
import numpy as np

from reconstruction.config import VideoProcessingConfig
from reconstruction.video.pipeline import VideoProcessingPipeline
from reconstruction.sfm.tracker import SfMTracker
from reconstruction.colmap import ColmapPipeline, is_colmap_available, validate_sfm_results
from reconstruction.depth.estimator import DepthEstimator
from reconstruction.pointcloud.fusion import PointCloudFuser
from reconstruction.mesh.builder import MeshBuilder
from reconstruction.segmentation import YOLOSegmenter
from reconstruction.geospatial import (
    sfm_to_local_metric,
    local_metric_to_threejs,
    compute_bounds_diagnostics
)


def run_reconstruction(
    video_path: str,
    project_id: str = "default_run",
    user_id: str = "local_user",
    max_keyframes: int = 50,
    stride: int = 2,
    detail_level: str = "high",
    engine: str = "auto",
    depth_method: str = "auto",
    enable_yolo: bool = True
):
    start_total_time = time.time()
    video_file = Path(video_path).resolve()
    if not video_file.exists():
        print(f"[ERROR] Input video file not found: {video_file}", file=sys.stderr)
        sys.exit(1)

    # Configure detail level
    if detail_level == "ultra":
        stride = 1
        voxel_size = 0.03
    elif detail_level == "high":
        stride = 2
        voxel_size = 0.04
    else:
        stride = 3
        voxel_size = 0.06

    print("====================================================================")
    print("  SIH26158: Single-Pass Drone Video to Accurate 3D Model System")
    print("  Local-First Metric Reconstruction Pipeline (RTX 3050 Optimized)")
    print("====================================================================")
    print(f"* Input Video:     {video_file.name}")
    print(f"* Project Sandbox: workspace/{project_id}")
    print(f"* User ID:         {user_id}")
    print(f"* Detail Level:    {detail_level.upper()} (stride={stride}, voxel={voxel_size}m)")
    print(f"* Max Keyframes:   {max_keyframes}")
    print(f"* SfM Engine:      {engine} (COLMAP available: {is_colmap_available()})")
    print(f"* Depth Engine:    {depth_method}")
    print(f"* YOLO Seg:        {'ENABLED' if enable_yolo else 'DISABLED'}")
    print("====================================================================\n")

    workspace_dir = Path("workspace") / project_id
    keyframes_dir = workspace_dir / "keyframes"
    poses_dir = workspace_dir / "poses"
    depth_dir = workspace_dir / "depth"
    segmentation_dir = workspace_dir / "segmentation"
    pointcloud_dir = workspace_dir / "pointcloud"
    mesh_dir = workspace_dir / "mesh"
    metrics_dir = workspace_dir / "metrics"
    colmap_dir = workspace_dir / "colmap"

    for d in [keyframes_dir, poses_dir, depth_dir, segmentation_dir, pointcloud_dir, mesh_dir, metrics_dir, colmap_dir]:
        d.mkdir(parents=True, exist_ok=True)

    # -------------------------------------------------------------
    # STAGE 1: Keyframe Extraction & Quality Filtering
    # -------------------------------------------------------------
    existing_keyframes = sorted(list(keyframes_dir.glob("*.png")))
    if len(existing_keyframes) >= 5:
        print(f"[STAGE 1/6] Reusing {len(existing_keyframes)} existing keyframes in {keyframes_dir}")
        keyframe_paths = existing_keyframes
    else:
        print("[STAGE 1/6] Ingesting Video & Extracting Adaptive Keyframes...")
        video_config = VideoProcessingConfig(max_keyframes=max_keyframes)
        pipeline = VideoProcessingPipeline(project_id=project_id, config=video_config)
        m1_result = pipeline.process(video_file)
        keyframe_paths = sorted(list(keyframes_dir.glob("*.png")))
        print(f"[OK] Extracted {len(keyframe_paths)} keyframes.")

    if len(keyframe_paths) < 2:
        print(f"[ERROR] Insufficient keyframes ({len(keyframe_paths)}) for 3D reconstruction.", file=sys.stderr)
        sys.exit(1)

    # Read first keyframe to obtain native dimensions
    sample_img = cv2.imread(str(keyframe_paths[0]))
    h_orig, w_orig = sample_img.shape[:2]

    # -------------------------------------------------------------
    # STAGE 2: Structure-from-Motion (SfM) Tracking with Strict Validation
    # -------------------------------------------------------------
    sfm_tracker = SfMTracker(processing_width=960)
    K = sfm_tracker.estimate_intrinsics(w_orig, h_orig)
    used_engine = "opencv"
    poses = []
    sparse_pts = np.empty((0, 3))
    sfm_val = None

    if engine in ["auto", "colmap"] and is_colmap_available():
        print("\n[STAGE 2/6] Structure-from-Motion via COLMAP Engine...")
        try:
            colmap_pipeline = ColmapPipeline()
            colmap_poses, colmap_pts, sfm_val = colmap_pipeline.run(keyframe_paths, colmap_dir)
            if sfm_val["status"] != "FAILED_SFM" and any(p.get("registered", False) for p in colmap_poses):
                poses = colmap_poses
                sparse_pts = colmap_pts
                used_engine = "colmap"
                print(f"[OK] COLMAP registered {sfm_val['registered_images']}/{sfm_val['total_images']} frames ({sfm_val['sparse_points']} points, confidence: {sfm_val['confidence']}).")
            else:
                print(f"[COLMAP] Registration failed validation: {sfm_val.get('message')}. Falling back to OpenCV tracker...")
        except Exception as e:
            print(f"[COLMAP] Exception ({e}), falling back to OpenCV tracker...")

    if not poses:
        print("\n[STAGE 2/6] Structure-from-Motion (SfM) Camera Tracking (OpenCV Essential Matrix RANSAC)...")
        cv_poses, sparse_pts, sfm_val = sfm_tracker.run(keyframe_paths)
        poses = [p.to_dict() for p in cv_poses]
        used_engine = "opencv"

    reg_poses_count = sum(1 for p in poses if p.get("registered", False))
    print(f"[SfM Evaluation] Registered: {reg_poses_count}/{len(keyframe_paths)} frames. Sparse points: {len(sparse_pts)}.")

    # Phase 6 & 16: Halt on invalid SfM reconstruction
    if reg_poses_count < 5 or len(sparse_pts) < 10:
        err_msg = f"COLMAP/SfM registered only {reg_poses_count} of {len(keyframe_paths)} frames with {len(sparse_pts)} sparse points. Insufficient geometry for metric 3D reconstruction."
        print(f"\n[FATAL SFM FAILURE] {err_msg}", file=sys.stderr)
        failure_summary = {
            "status": "FAILED_SFM",
            "coordinate_system": "LOCAL_SFM",
            "units": "meters",
            "registered_images": reg_poses_count,
            "total_images": len(keyframe_paths),
            "sparse_points": len(sparse_pts),
            "dense_points": 0,
            "mesh_vertices": 0,
            "mesh_triangles": 0,
            "scale": 1.0,
            "model_center": [0.0, 0.0, 0.0],
            "model_size": [0.0, 0.0, 0.0],
            "sfm_confidence": "FAILED",
            "depth_confidence": "N/A",
            "metric_confidence": "FAILED",
            "georeference_confidence": "FAILED",
            "error": err_msg
        }
        print("\n" + json.dumps(failure_summary, indent=2))
        return failure_summary

    poses_dict = {
        "project_id": project_id,
        "sfm_engine": used_engine,
        "camera_intrinsics_K": K.tolist(),
        "registered_poses_count": reg_poses_count,
        "total_poses_count": len(poses),
        "validation": sfm_val,
        "poses": poses
    }
    poses_file = poses_dir / "poses.json"
    with open(poses_file, "w") as f:
        json.dump(poses_dict, f, indent=2)

    print(f"[OK] Camera poses calculated via {used_engine.upper()}: {reg_poses_count}/{len(poses)} frames registered.")
    print(f"[OK] Saved poses to {poses_file}")

    # -------------------------------------------------------------
    # STAGE 3: Dense Depth Estimation & Depth Analysis
    # -------------------------------------------------------------
    print("\n[STAGE 3/6] Dense Depth Estimation & Confidence Analysis...")
    depth_estimator = DepthEstimator(target_resolution=480, method=depth_method)

    # Initialize YOLO Segmenter if enabled
    yolo_segmenter = None
    if enable_yolo:
        try:
            yolo_segmenter = YOLOSegmenter()
            if not yolo_segmenter.is_available():
                yolo_segmenter = None
            else:
                print("[OK] YOLOv8 instance segmentation initialized.")
        except Exception as e:
            print(f"[YOLO] Warning: Failed to initialize YOLO segmenter: {e}")
            yolo_segmenter = None
    
    depth_analysis_records = []
    depth_results = []
    loaded_images = []

    for i in range(len(keyframe_paths)):
        curr_img = cv2.imread(str(keyframe_paths[i]))
        loaded_images.append(curr_img)
        
        # Pair with adjacent keyframe for motion parallax
        if i < len(keyframe_paths) - 1:
            ref_img = cv2.imread(str(keyframe_paths[i + 1]))
        else:
            ref_img = loaded_images[i - 1] if i > 0 else None

        depth_res = depth_estimator.estimate_from_pair(curr_img, ref_img)
        depth_results.append(depth_res)

        # Save depth and confidence visualizations
        frame_stem = keyframe_paths[i].stem
        depth_png = depth_dir / f"{frame_stem}_depth.png"
        conf_png = depth_dir / f"{frame_stem}_confidence.png"
        depth_npy = depth_dir / f"{frame_stem}_depth.npy"

        cv2.imwrite(str(depth_png), depth_res.depth_colored)
        
        conf_u8 = (depth_res.confidence_map * 255).astype(np.uint8)
        cv2.imwrite(str(conf_png), conf_u8)
        np.save(str(depth_npy), depth_res.depth_map)

        high_conf_pct = float(np.mean(depth_res.confidence_map > 0.4) * 100.0)
        depth_std = float(np.std(depth_res.depth_map))
        median_depth = float(np.median(depth_res.depth_map))

        record = {
            "keyframe_index": i + 1,
            "filename": keyframe_paths[i].name,
            "mean_depth_m": round(depth_res.mean_depth, 2),
            "median_depth_m": round(median_depth, 2),
            "min_depth_m": round(depth_res.min_depth, 2),
            "max_depth_m": round(depth_res.max_depth, 2),
            "depth_std_m": round(depth_std, 2),
            "high_confidence_percent": round(high_conf_pct, 1),
            "depth_image": f"{frame_stem}_depth.png",
            "confidence_image": f"{frame_stem}_confidence.png"
        }

        if yolo_segmenter is not None:
            seg_res = yolo_segmenter.segment_image(curr_img, stem=frame_stem)
            seg_png = segmentation_dir / f"{frame_stem}_seg.png"
            cv2.imwrite(str(seg_png), seg_res.overlay_image)
            record["segmentation_image"] = f"{frame_stem}_seg.png"
            record["detected_objects"] = seg_res.summary.get("detected_classes", [])
            record["detections_count"] = seg_res.summary.get("total_objects", 0)

        depth_analysis_records.append(record)

    summary_tiles = []
    for idx in range(min(3, len(keyframe_paths))):
        orig_small = cv2.resize(loaded_images[idx], (320, 180))
        depth_small = cv2.resize(depth_results[idx].depth_colored, (320, 180))
        conf_small = cv2.cvtColor(cv2.resize((depth_results[idx].confidence_map * 255).astype(np.uint8), (320, 180)), cv2.COLOR_GRAY2BGR)
        tile = np.hstack([orig_small, depth_small, conf_small])
        cv2.putText(tile, f"Frame {idx+1}: Video RGB", (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2)
        cv2.putText(tile, "Estimated Depth (Turbo)", (330, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2)
        cv2.putText(tile, "Depth Confidence Map", (650, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2)
        summary_tiles.append(tile)

    if summary_tiles:
        composite_summary = np.vstack(summary_tiles)
        cv2.imwrite(str(depth_dir / "depth_analysis_summary.png"), composite_summary)

    all_means = [r["mean_depth_m"] for r in depth_analysis_records]
    all_confs = [r["high_confidence_percent"] for r in depth_analysis_records]
    all_detections = sum(r.get("detections_count", 0) for r in depth_analysis_records)
    all_classes = sorted(list({c for r in depth_analysis_records for c in r.get("detected_objects", [])}))

    depth_report = {
        "project_id": project_id,
        "total_keyframes": len(depth_analysis_records),
        "overall_scene_mean_depth_m": round(float(np.mean(all_means)), 2),
        "overall_scene_min_depth_m": round(float(min(r["min_depth_m"] for r in depth_analysis_records)), 2),
        "overall_scene_max_depth_m": round(float(max(r["max_depth_m"] for r in depth_analysis_records)), 2),
        "overall_high_confidence_pct": round(float(np.mean(all_confs)), 1),
        "metric_scale_units": "meters",
        "yolo_enabled": enable_yolo and (yolo_segmenter is not None and yolo_segmenter.is_available()),
        "total_detected_objects": all_detections,
        "detected_classes_summary": all_classes,
        "detail_level": detail_level,
        "per_frame_analysis": depth_analysis_records
    }
    with open(metrics_dir / "depth_analysis.json", "w") as f:
        json.dump(depth_report, f, indent=2)

    print(f"[OK] Dense depth computed for {len(depth_results)} keyframes.")
    print(f"[OK] Scene Depth Range: {depth_report['overall_scene_min_depth_m']}m - {depth_report['overall_scene_max_depth_m']}m (Mean: {depth_report['overall_scene_mean_depth_m']}m)")
    print(f"[OK] Average Depth Confidence: {depth_report['overall_high_confidence_pct']}%")

    # -------------------------------------------------------------
    # STAGE 4: Point Cloud Unprojection & Multi-View Fusion (Validated Poses Only)
    # -------------------------------------------------------------
    print(f"\n[STAGE 4/6] 3D Back-Projection & Multi-View Point Cloud Fusion (stride={stride}, voxel={voxel_size}m)...")
    fuser = PointCloudFuser(voxel_size=voxel_size, min_confidence=0.18)
    
    all_pts_list = []
    all_cols_list = []
    skipped_count = 0

    for i in range(len(keyframe_paths)):
        pose = poses[i]
        # Phase 7: Strictly skip frames without validated camera poses
        if not pose.get("registered", False) or pose.get("rotation") is None:
            skipped_count += 1
            print(f"  [Fusion] Skipping unregistered keyframe {i+1}/{len(keyframe_paths)} ({keyframe_paths[i].name}) to preserve metric integrity.")
            continue

        rot_raw = pose["rotation"]
        trans_raw = pose["translation"]
        R = np.array(rot_raw)
        t = np.array(trans_raw).reshape(3, 1)

        d_res = depth_results[i]
        img = loaded_images[i]

        pts_frame, cols_frame = fuser.unproject_depth(
            d_res.depth_map,
            img,
            K,
            R,
            t,
            confidence_map=d_res.confidence_map,
            stride=stride
        )
        if len(pts_frame) > 0:
            all_pts_list.append(pts_frame)
            all_cols_list.append(cols_frame)

    if not all_pts_list:
        print("[ERROR] Point cloud fusion generated 0 points from registered poses.", file=sys.stderr)
        sys.exit(1)

    raw_points_sfm = np.vstack(all_pts_list)
    raw_colors = np.vstack(all_cols_list)
    print(f"[OK] Raw unprojected 3D points (LOCAL_SFM): {len(raw_points_sfm):,} (fused {len(keyframe_paths)-skipped_count} frames, skipped {skipped_count})")

    # Voxel grid downsampling
    down_points_sfm, down_colors = fuser.voxel_downsample(raw_points_sfm, raw_colors)
    print(f"[OK] Voxel downsampled points: {len(down_points_sfm):,}")

    # Outlier removal and coordinate sanity filter
    clean_points_sfm, clean_colors = fuser.remove_outliers(down_points_sfm, down_colors, k_std=2.2)
    print(f"[OK] Outlier filtered points: {len(clean_points_sfm):,}")

    # Phase 2 & 8: Compute & Log MODEL_BOUNDS in LOCAL_SFM
    sfm_bounds = fuser.log_diagnostics(clean_points_sfm, label="LOCAL_SFM")

    # Phase 3: Canonical Coordinate Transformation:
    # 1. LOCAL_SFM -> LOCAL_METRIC (+X East, +Y North, +Z Up in meters)
    clean_points_metric = sfm_to_local_metric(clean_points_sfm)
    metric_bounds = fuser.log_diagnostics(clean_points_metric, label="LOCAL_METRIC")

    # 2. LOCAL_METRIC -> THREEJS (+X Right, +Y Up, -Z Forward)
    clean_points_three = local_metric_to_threejs(clean_points_metric)
    three_bounds = fuser.log_diagnostics(clean_points_three, label="THREEJS")

    # Export PLY point cloud in canonical THREEJS coordinate system
    ply_path = pointcloud_dir / "dense.ply"
    fuser.export_ply(clean_points_three, clean_colors, ply_path)
    print(f"[OK] Saved dense PLY to {ply_path}")

    # -------------------------------------------------------------
    # STAGE 5: Surface Mesh & Colored OBJ + GLB Generation
    # -------------------------------------------------------------
    print("\n[STAGE 5/6] 3D Surface Reconstruction & Wavefront OBJ + GLB Generation...")
    mesh_builder = MeshBuilder(target_faces=80000, max_points=80000)
    obj_path = mesh_dir / "model.obj"
    glb_path = mesh_dir / "model.glb"
    
    sfm_conf = sfm_val.get("confidence", "MEDIUM") if sfm_val else "MEDIUM"
    exported_obj, exported_glb, meta_path, model_bounds = mesh_builder.build_and_export(
        clean_points_three,
        clean_colors,
        obj_path,
        glb_path=glb_path,
        coordinate_frame="THREEJS",
        extra_metadata={
            "project_id": project_id,
            "registered_images": reg_poses_count,
            "total_images": len(keyframe_paths),
            "sparse_points": len(sparse_pts),
            "dense_points": len(clean_points_three),
            "sfm_confidence": sfm_conf,
            "depth_confidence": f"{depth_report['overall_high_confidence_pct']}%",
            "metric_confidence": "ESTIMATED" if reg_poses_count >= 18 else "LOW",
            "georeference_confidence": "LOCAL_METRIC_ONLY"
        }
    )
    print(f"[OK] Saved 3D OBJ to {exported_obj}")
    if exported_glb:
        print(f"[OK] Saved 3D GLB to {exported_glb}")
    print(f"[OK] Saved model metadata to {meta_path}")

    # -------------------------------------------------------------
    # STAGE 6: Local Web Viewer Asset Synchronization
    # -------------------------------------------------------------
    print("\n[STAGE 6/6] Synchronizing Assets with Local Web Viewer...")
    upload_dir = Path("backend") / "uploads" / user_id / project_id
    upload_dir.mkdir(parents=True, exist_ok=True)

    # Copy 3D Model assets (GLB preferred; OBJ as fallback)
    if exported_glb and exported_glb.exists():
        shutil.copy2(str(exported_glb), str(upload_dir / "model.glb"))
    shutil.copy2(str(exported_obj), str(upload_dir / "model.obj"))
    shutil.copy2(str(ply_path), str(upload_dir / "dense.ply"))
    shutil.copy2(str(meta_path), str(upload_dir / "model_metadata.json"))
    shutil.copy2(str(metrics_dir / "depth_analysis.json"), str(upload_dir / "depth_analysis.json"))
    
    if (depth_dir / "depth_analysis_summary.png").exists():
        shutil.copy2(str(depth_dir / "depth_analysis_summary.png"), str(upload_dir / "depth_analysis_summary.png"))

    for i in range(len(keyframe_paths)):
        stem = keyframe_paths[i].stem
        shutil.copy2(str(keyframe_paths[i]), str(upload_dir / f"{stem}.png"))
        d_img = depth_dir / f"{stem}_depth.png"
        c_img = depth_dir / f"{stem}_confidence.png"
        s_img = segmentation_dir / f"{stem}_seg.png"
        if d_img.exists():
            shutil.copy2(str(d_img), str(upload_dir / f"{stem}_depth.png"))
        if c_img.exists():
            shutil.copy2(str(c_img), str(upload_dir / f"{stem}_confidence.png"))
        if s_img.exists():
            shutil.copy2(str(s_img), str(upload_dir / f"{stem}_seg.png"))

    elapsed = round(time.time() - start_total_time, 2)
    print(f"====================================================================\n")
    print(f"  RECONSTRUCTION COMPLETE in {elapsed}s")
    print(f"  * 3D Model (OBJ): {upload_dir / 'model.obj'}")
    if (upload_dir / 'model.glb').exists():
        glb_size = (upload_dir / 'model.glb').stat().st_size / (1024 * 1024)
        print(f"  * 3D Model (GLB): {upload_dir / 'model.glb'} ({glb_size:.1f} MB)")
    print(f"  * Dense Cloud:    {upload_dir / 'dense.ply'} ({len(clean_points_three):,} pts)")
    print(f"  * Metadata:       {upload_dir / 'model_metadata.json'}")
    print(f"  * Depth Report:   {upload_dir / 'depth_analysis.json'}")
    print(f"====================================================================")

    # Machine-readable reconstruction summary output
    recon_summary = {
        "status": "VALID_LOCAL_3D" if reg_poses_count >= 18 else "LOW_CONFIDENCE",
        "coordinate_system": "THREEJS",
        "units": "meters",
        "registered_images": reg_poses_count,
        "total_images": len(keyframe_paths),
        "sparse_points": len(sparse_pts),
        "dense_points": len(clean_points_three),
        "mesh_vertices": model_bounds.num_points,
        "mesh_triangles": mesh_builder.target_faces,
        "scale": 1.0,
        "model_center": [round(model_bounds.center_x, 4), round(model_bounds.center_y, 4), round(model_bounds.center_z, 4)],
        "model_size": [round(model_bounds.width, 4), round(model_bounds.height, 4), round(model_bounds.depth, 4)],
        "sfm_confidence": sfm_conf,
        "depth_confidence": f"{depth_report['overall_high_confidence_pct']}%",
        "metric_confidence": "ESTIMATED" if reg_poses_count >= 18 else "LOW",
        "georeference_confidence": "LOCAL_METRIC_ONLY"
    }

    print("\n--- RECONSTRUCTION SUMMARY JSON ---")
    print(json.dumps(recon_summary, indent=2))
    print("-----------------------------------\n")

    return {
        "status": "success",
        "project_id": project_id,
        "elapsed_sec": elapsed,
        "points_count": len(clean_points_three),
        "keyframes_count": len(keyframe_paths),
        "obj_path": str(upload_dir / "model.obj"),
        "glb_path": str(upload_dir / "model.glb") if (upload_dir / "model.glb").exists() else None,
        "ply_path": str(upload_dir / "dense.ply"),
        "metadata_path": str(upload_dir / "model_metadata.json"),
        "depth_report": depth_report,
        "summary": recon_summary
    }


def main():
    parser = argparse.ArgumentParser(description="SIH26158 Master 3D Reconstruction Pipeline")
    parser.add_argument("video", type=str, help="Path to input drone video (.mp4/.mov)")
    parser.add_argument("--project-id", type=str, default="drone_recon", help="Project identifier for workspace sandbox")
    parser.add_argument("--user-id", type=str, default="local_user", help="User ID for local uploads")
    parser.add_argument("--max-keyframes", type=int, default=50, help="Max keyframes to extract (default: 50)")
    parser.add_argument("--stride", type=int, default=2, help="Grid sampling stride for dense unprojection (default: 2)")
    parser.add_argument("--detail-level", type=str, default="high", choices=["standard", "high", "ultra"], help="Reconstruction detail level (default: high)")
    parser.add_argument("--engine", type=str, default="auto", choices=["auto", "colmap", "opencv"], help="Structure-from-Motion engine (default: auto)")
    parser.add_argument("--depth-method", type=str, default="depth_anything", choices=["auto", "depth_anything", "optical_flow"], help="Dense depth estimation engine (default: depth_anything)")
    parser.add_argument("--enable-yolo", action="store_true", default=True, help="Enable YOLOv8 instance segmentation (default: True)")
    parser.add_argument("--no-yolo", dest="enable_yolo", action="store_false", help="Disable YOLOv8 segmentation")
    args = parser.parse_args()

    run_reconstruction(
        args.video,
        project_id=args.project_id,
        user_id=args.user_id,
        max_keyframes=args.max_keyframes,
        stride=args.stride,
        detail_level=args.detail_level,
        engine=args.engine,
        depth_method=args.depth_method,
        enable_yolo=args.enable_yolo
    )


if __name__ == "__main__":
    main()
