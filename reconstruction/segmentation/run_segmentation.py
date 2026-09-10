"""
Standalone YOLO Segmentation Runner
Processes keyframes for a given project, saves segmented overlay images,
and updates depth_analysis.json with detected element tags.
"""

import argparse
import json
import shutil
from pathlib import Path
import cv2

from reconstruction.segmentation.segmenter import YOLOSegmenter


def run_project_segmentation(project_id: str = "hjgjghjghj", user_id: str = "local_user"):
    workspace_dir = Path("workspace") / project_id
    keyframes_dir = workspace_dir / "keyframes"
    segmentation_dir = workspace_dir / "segmentation"
    upload_dir = Path("backend") / "uploads" / user_id / project_id

    segmentation_dir.mkdir(parents=True, exist_ok=True)
    upload_dir.mkdir(parents=True, exist_ok=True)

    keyframe_paths = sorted(list(keyframes_dir.glob("keyframe_*.png")))
    if not keyframe_paths and upload_dir.exists():
        keyframe_paths = sorted([
            p for p in upload_dir.glob("keyframe_*.png")
            if not p.stem.endswith("_depth") and not p.stem.endswith("_confidence") and not p.stem.endswith("_seg")
        ])

    if not keyframe_paths:
        print(f"[ERROR] No keyframes found in {keyframes_dir} or {upload_dir}")
        return

    print(f"[YOLO] Found {len(keyframe_paths)} keyframes in {keyframes_dir}")
    print("[YOLO] Initializing YOLOv8 instance segmentation model...")
    segmenter = YOLOSegmenter()

    if not segmenter.is_available():
        print("[ERROR] YOLO model could not be initialized.")
        return

    # Load existing depth_analysis.json if present
    metrics_file = workspace_dir / "metrics" / "depth_analysis.json"
    upload_metrics = upload_dir / "depth_analysis.json"
    depth_report = None

    if metrics_file.exists():
        with open(metrics_file, "r") as f:
            depth_report = json.load(f)
    elif upload_metrics.exists():
        with open(upload_metrics, "r") as f:
            depth_report = json.load(f)

    frame_records = depth_report.get("per_frame_analysis", []) if depth_report else []

    total_detections_all = 0
    all_detected_classes = set()

    for idx, kf_path in enumerate(keyframe_paths):
        stem = kf_path.stem
        img = cv2.imread(str(kf_path))
        if img is None:
            continue

        res = segmenter.segment_image(img, stem=stem)
        seg_png = segmentation_dir / f"{stem}_seg.png"
        cv2.imwrite(str(seg_png), res.overlay_image)

        # Copy to web upload directory
        shutil.copy2(str(seg_png), str(upload_dir / f"{stem}_seg.png"))

        det_classes = res.summary.get("detected_classes", [])
        det_count = res.summary.get("total_objects", 0)
        total_detections_all += det_count
        for c in det_classes:
            all_detected_classes.add(c)

        print(f"[{idx+1}/{len(keyframe_paths)}] {stem}: {det_classes if det_classes else 'No objects'}")

        if idx < len(frame_records):
            frame_records[idx]["segmentation_image"] = f"{stem}_seg.png"
            frame_records[idx]["detected_objects"] = det_classes
            frame_records[idx]["detections_count"] = det_count

    if depth_report:
        depth_report["yolo_enabled"] = True
        depth_report["total_detected_objects"] = total_detections_all
        depth_report["detected_classes_summary"] = sorted(list(all_detected_classes))
        depth_report["per_frame_analysis"] = frame_records

        if metrics_file.parent.exists():
            with open(metrics_file, "w") as f:
                json.dump(depth_report, f, indent=2)
        with open(upload_metrics, "w") as f:
            json.dump(depth_report, f, indent=2)

    print("\n====================================================================")
    print(f"  YOLO SEGMENTATION COMPLETE for {len(keyframe_paths)} keyframes")
    print(f"  * Overlays saved to: {upload_dir}")
    print(f"  * Total Elements Detected: {total_detections_all}")
    print(f"  * Summary: {sorted(list(all_detected_classes))}")
    print("====================================================================")


def main():
    parser = argparse.ArgumentParser(description="Standalone YOLO Keyframe Segmenter")
    parser.add_argument("--project-id", type=str, default="hjgjghjghj", help="Project identifier")
    parser.add_argument("--user-id", type=str, default="local_user", help="User ID")
    args = parser.parse_args()

    run_project_segmentation(project_id=args.project_id, user_id=args.user_id)


if __name__ == "__main__":
    main()
