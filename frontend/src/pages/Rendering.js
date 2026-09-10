import React, { Suspense, useRef, useState, useMemo, useEffect, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Canvas, useThree, useLoader } from "@react-three/fiber";
import { OrbitControls, Html, useGLTF } from "@react-three/drei";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader";
import * as THREE from "three";
import axios from "axios";
import Navbar from "../components/Navbar";
import {
  ArrowLeft,
  Box,
  Eye,
  Grid as GridIcon,
  RotateCcw,
  Activity,
  Layers,
  ChevronRight,
  ChevronLeft,
  Sliders,
  X,
  Crosshair,
  Compass
} from "lucide-react";

// ─── Material Mode Applier (Preserves Metric Geometry) ───────────────────────

function applyMaterialMode(object, { wireframe, pointCloud, pointSize, hasColors }) {
  const newChildren = [];
  object.traverse((child) => {
    if (!child.isMesh) return;
    if (!child.geometry.attributes.normal) {
      child.geometry.computeVertexNormals();
    }
    if (pointCloud) {
      const mat = new THREE.PointsMaterial({
        size: pointSize || 0.05,
        vertexColors: hasColors,
        color: hasColors ? 0xffffff : new THREE.Color("#38bdf8"),
        sizeAttenuation: true
      });
      newChildren.push(new THREE.Points(child.geometry.clone(), mat));
    } else {
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: hasColors,
        color: hasColors ? 0xffffff : new THREE.Color("#14b8a6"),
        roughness: 0.55,
        metalness: 0.05,
        wireframe,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(child.geometry.clone(), mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      newChildren.push(mesh);
    }
  });
  return newChildren;
}

// ─── OBJ Model Component ────────────────────────────────────────────────────

const OBJModel = ({ objUrl, wireframe, pointCloud, pointSize, onModelMeasured, localOrigin, offset }) => {
  const rawObj = useLoader(OBJLoader, objUrl);

  const { group, bounds } = useMemo(() => {
    const grp = new THREE.Group();
    let hasColors = false;
    rawObj.traverse((c) => {
      if (c.isMesh && c.geometry.attributes.color) hasColors = true;
    });

    const children = applyMaterialMode(rawObj, { wireframe, pointCloud, pointSize, hasColors });
    children.forEach((c) => grp.add(c));
    grp.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(grp);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1.0;

    return {
      group: grp,
      bounds: {
        min: box.min,
        max: box.max,
        center,
        size,
        maxDim,
        radius: size.length() * 0.5
      }
    };
  }, [rawObj, wireframe, pointCloud, pointSize]);

  useEffect(() => {
    if (onModelMeasured && bounds) {
      onModelMeasured(bounds);
    }
  }, [bounds, onModelMeasured]);

  const pos = localOrigin && offset ? [-offset.x, -offset.y, -offset.z] : [0, 0, 0];

  return <primitive object={group} position={pos} />;
};

// ─── GLB Model Component ────────────────────────────────────────────────────

const GLBModel = ({ glbUrl, wireframe, pointCloud, pointSize, onModelMeasured, localOrigin, offset }) => {
  const { scene } = useGLTF(glbUrl);

  const { clonedScene, bounds } = useMemo(() => {
    const cloned = scene.clone(true);
    let hasColors = false;
    cloned.traverse((c) => {
      if (c.isMesh && c.geometry.attributes.color) hasColors = true;
    });

    cloned.traverse((child) => {
      if (!child.isMesh) return;
      if (!child.geometry.attributes.normal) {
        child.geometry.computeVertexNormals();
      }
      if (pointCloud) {
        child.material = new THREE.PointsMaterial({
          size: pointSize || 0.05,
          vertexColors: hasColors,
          color: hasColors ? 0xffffff : new THREE.Color("#38bdf8"),
          sizeAttenuation: true
        });
      } else {
        child.material = new THREE.MeshStandardMaterial({
          vertexColors: hasColors,
          color: hasColors ? 0xffffff : new THREE.Color("#14b8a6"),
          roughness: 0.55,
          metalness: 0.05,
          wireframe,
          side: THREE.DoubleSide
        });
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    cloned.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(cloned);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1.0;

    return {
      clonedScene: cloned,
      bounds: {
        min: box.min,
        max: box.max,
        center,
        size,
        maxDim,
        radius: size.length() * 0.5
      }
    };
  }, [scene, wireframe, pointCloud, pointSize]);

  useEffect(() => {
    if (onModelMeasured && bounds) {
      onModelMeasured(bounds);
    }
  }, [bounds, onModelMeasured]);

  const pos = localOrigin && offset ? [-offset.x, -offset.y, -offset.z] : [0, 0, 0];

  return <primitive object={clonedScene} position={pos} />;
};

// ─── Camera Auto-Framing & Controller ───────────────────────────────────────

const CameraController = ({ modelBounds, localOrigin, resetTrigger }) => {
  const { camera } = useThree();
  const controlsRef = useRef();

  const frameModel = useCallback(() => {
    if (!modelBounds || !controlsRef.current) return;

    // In localOrigin mode, the model is rendered at (0, 0, 0).
    // In world mode, the model is at modelBounds.center.
    const target = localOrigin
      ? new THREE.Vector3(0, 0, 0)
      : modelBounds.center.clone();

    const maxDim = modelBounds.maxDim || 5.0;
    const radius = modelBounds.radius || maxDim * 0.5;
    const fovRad = (camera.fov * Math.PI) / 180;
    const distance = Math.max(radius / Math.sin(fovRad / 2), maxDim * 1.5);

    camera.near = Math.max(maxDim / 10000, 0.01);
    camera.far = Math.max(maxDim * 100, 2000);
    camera.position.set(
      target.x + distance * 0.65,
      target.y + distance * 0.45,
      target.z + distance * 0.85
    );
    camera.lookAt(target);
    camera.updateProjectionMatrix();

    controlsRef.current.target.copy(target);
    controlsRef.current.update();
  }, [modelBounds, localOrigin, camera]);

  // Frame whenever modelBounds is computed or localOrigin changes
  useEffect(() => {
    frameModel();
  }, [frameModel]);

  // External reset view trigger
  useEffect(() => {
    if (resetTrigger > 0) {
      frameModel();
    }
  }, [resetTrigger, frameModel]);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={0.06}
      minDistance={0.05}
      maxDistance={5000}
    />
  );
};

// ─── Scene Markers: Model Center & Origin ───────────────────────────────────

const SceneMarkers = ({ modelBounds, localOrigin, showCenter, showOrigin, showBounds }) => {
  if (!modelBounds) return null;

  const centerPos = localOrigin ? [0, 0, 0] : [modelBounds.center.x, modelBounds.center.y, modelBounds.center.z];
  const originPos = localOrigin
    ? [-modelBounds.center.x, -modelBounds.center.y, -modelBounds.center.z]
    : [0, 0, 0];

  return (
    <>
      {/* Model Center Marker */}
      {showCenter && (
        <group position={centerPos}>
          <mesh>
            <sphereGeometry args={[Math.max(modelBounds.maxDim * 0.015, 0.08), 16, 16]} />
            <meshBasicMaterial color="#38bdf8" wireframe={false} />
          </mesh>
          <Html position={[0, Math.max(modelBounds.maxDim * 0.03, 0.2), 0]} center>
            <div className="bg-cyan-950/90 border border-cyan-400/80 px-2 py-0.5 rounded text-[10px] font-mono font-bold text-cyan-300 shadow-xl whitespace-nowrap pointer-events-none">
              🎯 MODEL CENTER ({modelBounds.center.x.toFixed(2)}, {modelBounds.center.y.toFixed(2)}, {modelBounds.center.z.toFixed(2)})m
            </div>
          </Html>
        </group>
      )}

      {/* World Scene Origin Marker */}
      {showOrigin && (
        <group position={originPos}>
          <axesHelper args={[Math.max(modelBounds.maxDim * 0.15, 1.5)]} />
          <mesh>
            <sphereGeometry args={[Math.max(modelBounds.maxDim * 0.01, 0.05), 12, 12]} />
            <meshBasicMaterial color="#f43f5e" />
          </mesh>
          <Html position={[0, -Math.max(modelBounds.maxDim * 0.02, 0.15), 0]} center>
            <div className="bg-rose-950/90 border border-rose-500/80 px-1.5 py-0.5 rounded text-[9px] font-mono text-rose-300 shadow-xl whitespace-nowrap pointer-events-none">
              📍 SCENE ORIGIN (0,0,0)
            </div>
          </Html>
        </group>
      )}

      {/* Bounding Box Wireframe */}
      {showBounds && (
        <group position={centerPos}>
          <mesh>
            <boxGeometry args={[modelBounds.size.x, modelBounds.size.y, modelBounds.size.z]} />
            <meshBasicMaterial color="#06b6d4" wireframe={true} transparent={true} opacity={0.4} />
          </mesh>
        </group>
      )}
    </>
  );
};

// ─── Loading Spinner ────────────────────────────────────────────────────────

const LoadingSpinner = () => (
  <Html center>
    <div className="flex flex-col items-center justify-center p-6 bg-gray-900/90 border border-teal-500/40 rounded-xl shadow-2xl backdrop-blur-md text-white">
      <div className="w-12 h-12 border-4 border-teal-400 border-t-transparent rounded-full animate-spin mb-3"></div>
      <p className="text-sm font-semibold tracking-wide text-teal-300">Loading 3D Model...</p>
      <p className="text-xs text-gray-400 mt-1">Preserving real-world metric dimensions</p>
    </div>
  </Html>
);

// ─── Main Page Component ────────────────────────────────────────────────────

const Rendering = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const objFileUrl = params.get("objFileUrl");
  const projectName = params.get("projectName") || (objFileUrl ? objFileUrl.split("/")[objFileUrl.split("/").length - 2] : "project");

  const [wireframe, setWireframe] = useState(false);
  const [pointCloud, setPointCloud] = useState(false);
  const [pointSize, setPointSize] = useState(0.05);
  const [showGrid, setShowGrid] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const [showCenterMarker, setShowCenterMarker] = useState(true);
  const [showOriginMarker, setShowOriginMarker] = useState(true);
  const [showBoundingBox, setShowBoundingBox] = useState(false);
  const [localOriginMode, setLocalOriginMode] = useState(true);
  const [showDebugHUD, setShowDebugHUD] = useState(true);
  const [showDepthPanel, setShowDepthPanel] = useState(false);
  const [resetTrigger, setResetTrigger] = useState(0);

  const [measuredBounds, setMeasuredBounds] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [depthData, setDepthData] = useState(null);
  const [loadingDepth, setLoadingDepth] = useState(false);
  const [selectedFrameIdx, setSelectedFrameIdx] = useState(0);
  const [viewMode, setViewMode] = useState("depth");

  const isGLB = objFileUrl && objFileUrl.toLowerCase().endsWith(".glb");

  // Fetch model metadata and depth analysis
  useEffect(() => {
    if (projectName) {
      setLoadingDepth(true);
      // Fetch model metadata if available
      axios.get(`http://localhost:8000/uploads/local_user/${projectName}/model_metadata.json`)
        .then(res => setMetadata(res.data))
        .catch(() => {});

      // Fetch depth analysis
      axios.get(`http://localhost:8000/s3/projects/local_user/${projectName}/depth-analysis`)
        .then(res => {
          setDepthData(res.data);
          setLoadingDepth(false);
        })
        .catch(() => {
          setLoadingDepth(false);
        });
    }
  }, [projectName]);

  const handleResetView = () => {
    setResetTrigger(prev => prev + 1);
  };

  const handleModelMeasured = useCallback((bounds) => {
    setMeasuredBounds(bounds);
  }, []);

  if (!objFileUrl) {
    return (
      <div className="min-h-screen bg-gray-950 text-white">
        <Navbar />
        <div className="flex flex-col items-center justify-center h-[80vh]">
          <Box className="w-16 h-16 text-teal-400 mb-4 animate-bounce" />
          <h2 className="text-2xl font-bold mb-2">No 3D Model URL Provided</h2>
          <p className="text-gray-400 mb-6">Please select a project from the dashboard to view its reconstruction.</p>
          <button
            onClick={() => navigate("/projects")}
            className="px-6 py-2.5 bg-teal-600 hover:bg-teal-500 rounded-lg font-medium transition-colors flex items-center"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Projects
          </button>
        </div>
      </div>
    );
  }

  const filename = objFileUrl.split("/").pop() || "model.obj";
  const frames = depthData?.per_frame_analysis || [];
  const currentFrame = frames[selectedFrameIdx];

  // Active bounds: prioritize measured geometry from Three.js scene
  const bounds = measuredBounds || (metadata?.bounds ? {
    min: new THREE.Vector3(metadata.bounds.min_x, metadata.bounds.min_y, metadata.bounds.min_z),
    max: new THREE.Vector3(metadata.bounds.max_x, metadata.bounds.max_y, metadata.bounds.max_z),
    center: new THREE.Vector3(metadata.bounds.center_x, metadata.bounds.center_y, metadata.bounds.center_z),
    size: new THREE.Vector3(metadata.bounds.width, metadata.bounds.height, metadata.bounds.depth),
    maxDim: Math.max(metadata.bounds.width, metadata.bounds.height, metadata.bounds.depth),
    radius: Math.max(metadata.bounds.width, metadata.bounds.height, metadata.bounds.depth) * 0.5
  } : null);

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      <Navbar />

      <main className="flex-1 flex flex-col p-4 max-w-7xl mx-auto w-full relative">
        {/* Header Bar */}
        <div className="flex flex-wrap items-center justify-between gap-4 mb-4 bg-gray-900/80 border border-gray-800 p-4 rounded-xl shadow-lg">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate("/projects")}
              className="p-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-300 hover:text-white transition-colors"
              title="Back to Projects"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-lg font-bold flex items-center gap-2">
                <Box className="w-5 h-5 text-teal-400" />
                SIH26158 3D Local Reconstruction Viewer
              </h1>
              <p className="text-xs text-gray-400">
                Project: <span className="text-teal-300 font-semibold">{projectName}</span> | Model: <span className="text-gray-300 font-mono">{filename}</span>
                {isGLB ? (
                  <span className="ml-2 px-1.5 py-0.5 bg-emerald-900/60 border border-emerald-600/40 text-emerald-400 rounded text-[10px] font-mono">GLB (Binary)</span>
                ) : (
                  <span className="ml-2 px-1.5 py-0.5 bg-amber-900/60 border border-amber-600/40 text-amber-400 rounded text-[10px] font-mono">OBJ</span>
                )}
                <span className="ml-2 px-1.5 py-0.5 bg-blue-900/60 border border-blue-600/40 text-blue-300 rounded text-[10px] font-mono">
                  {localOriginMode ? "Mode: Local Origin (P - Center)" : "Mode: Reconstructed World"}
                </span>
              </p>
            </div>
          </div>

          {/* Top Control Bar */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowDepthPanel(!showDepthPanel)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                showDepthPanel ? "bg-amber-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              Depth Analysis
            </button>

            <button
              onClick={() => setShowDebugHUD(!showDebugHUD)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                showDebugHUD ? "bg-cyan-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
              }`}
            >
              <Compass className="w-3.5 h-3.5" />
              Diagnostics HUD
            </button>

            <button
              onClick={() => setLocalOriginMode(!localOriginMode)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                localOriginMode ? "bg-teal-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
              }`}
              title="Toggle between centering at local scene origin or showing absolute reconstructed world coordinates"
            >
              <Crosshair className="w-3.5 h-3.5" />
              {localOriginMode ? "Local Origin" : "World Origin"}
            </button>

            <button
              onClick={() => setWireframe(!wireframe)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                wireframe ? "bg-teal-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              Wireframe
            </button>

            <button
              onClick={() => setPointCloud(!pointCloud)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                pointCloud ? "bg-teal-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              Point Cloud
            </button>

            {pointCloud && (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-800/90 rounded-lg text-xs border border-gray-700">
                <Sliders className="w-3 h-3 text-cyan-400" />
                <span className="text-[10px] text-gray-400">Size:</span>
                <input
                  type="range"
                  min="0.01"
                  max="0.2"
                  step="0.005"
                  value={pointSize}
                  onChange={(e) => setPointSize(parseFloat(e.target.value))}
                  className="w-16 h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                />
              </div>
            )}

            <button
              onClick={() => setShowGrid(!showGrid)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                showGrid ? "bg-gray-700 text-teal-300" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
              }`}
            >
              <GridIcon className="w-3.5 h-3.5" />
              Grid
            </button>

            <button
              onClick={handleResetView}
              className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Auto-Frame Model
            </button>
          </div>
        </div>

        {/* Main Canvas Area + Split Drawer */}
        <div className="flex-1 flex gap-4 min-h-[600px] relative">
          {/* 3D Canvas Viewport */}
          <div className="flex-1 relative rounded-2xl overflow-hidden border border-teal-500/30 shadow-2xl bg-gradient-to-b from-gray-900 to-black min-h-[580px]">
            <Canvas
              shadows
              camera={{ position: [0, 5, 10], fov: 48, near: 0.05, far: 3000 }}
              gl={{ antialias: true, alpha: false }}
            >
              <color attach="background" args={["#080c18"]} />
              <ambientLight intensity={1.1} />
              <directionalLight position={[10, 20, 15]} intensity={1.8} castShadow />
              <directionalLight position={[-10, 10, -15]} intensity={0.8} />
              <directionalLight position={[0, -10, 0]} intensity={0.4} />

              {/* Metric Ground Grid */}
              {showGrid && (
                <gridHelper
                  args={[
                    Math.max(bounds?.maxDim ? bounds.maxDim * 2.5 : 50, 30),
                    30,
                    "#14b8a6",
                    "#334155"
                  ]}
                  position={localOriginMode ? [0, bounds ? -bounds.size.y * 0.5 : -1, 0] : [0, bounds?.min.y || -1, 0]}
                />
              )}

              {/* Scene Origin Axes */}
              {showAxes && (
                <axesHelper args={[Math.max(bounds?.maxDim ? bounds.maxDim * 0.2 : 5, 2)]} position={[0, 0, 0]} />
              )}

              <Suspense fallback={<LoadingSpinner />}>
                {isGLB ? (
                  <GLBModel
                    glbUrl={objFileUrl}
                    wireframe={wireframe}
                    pointCloud={pointCloud}
                    pointSize={pointSize}
                    onModelMeasured={handleModelMeasured}
                    localOrigin={localOriginMode}
                    offset={bounds?.center}
                  />
                ) : (
                  <OBJModel
                    objUrl={objFileUrl}
                    wireframe={wireframe}
                    pointCloud={pointCloud}
                    pointSize={pointSize}
                    onModelMeasured={handleModelMeasured}
                    localOrigin={localOriginMode}
                    offset={bounds?.center}
                  />
                )}
              </Suspense>

              {/* Model Center and Scene Origin Markers */}
              <SceneMarkers
                modelBounds={bounds}
                localOrigin={localOriginMode}
                showCenter={showCenterMarker}
                showOrigin={showOriginMarker}
                showBounds={showBoundingBox}
              />

              {/* Dynamic Camera Framing & Controls */}
              <CameraController
                modelBounds={bounds}
                localOrigin={localOriginMode}
                resetTrigger={resetTrigger}
              />
            </Canvas>

            {/* Viewport Overlay Controls Guide */}
            <div className="absolute bottom-4 left-4 bg-gray-950/85 border border-gray-800/80 px-3.5 py-2 rounded-lg backdrop-blur text-[11px] text-gray-400 pointer-events-none flex items-center gap-4 shadow-lg">
              <span>🖱️ Left-Click: Orbit Target</span>
              <span>🖐️ Right-Click: Pan</span>
              <span>🔍 Scroll: Zoom</span>
              <span className="text-teal-400 font-mono">Units: 1 unit = 1 meter</span>
            </div>

            <div className="absolute bottom-4 right-4 bg-gray-950/85 border border-teal-500/40 px-3 py-1.5 rounded-lg backdrop-blur text-[11px] text-teal-300 pointer-events-none flex items-center gap-2 shadow-lg">
              <span className="w-2 h-2 rounded-full bg-teal-400 animate-pulse"></span>
              Canonical Frame: THREEJS (Y-Up, Metric)
            </div>

            {/* Developer Diagnostics HUD (Phase 12) */}
            {showDebugHUD && bounds && (
              <div className="absolute top-4 left-4 w-80 bg-gray-950/90 border border-gray-800 rounded-xl p-3 backdrop-blur shadow-2xl text-xs z-10">
                <div className="flex items-center justify-between pb-2 border-b border-gray-800 mb-2">
                  <span className="font-bold text-teal-300 flex items-center gap-1.5">
                    <Compass className="w-3.5 h-3.5 text-teal-400" />
                    Reconstruction Diagnostics
                  </span>
                  <button
                    onClick={() => setShowDebugHUD(false)}
                    className="text-gray-400 hover:text-white p-0.5 rounded"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Model Bounds Metrics */}
                <div className="space-y-1.5 font-mono text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Dimensions (WxHxD):</span>
                    <span className="text-white font-semibold">
                      {bounds.size.x.toFixed(2)}m × {bounds.size.y.toFixed(2)}m × {bounds.size.z.toFixed(2)}m
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Bounding Diagonal:</span>
                    <span className="text-teal-300 font-semibold">
                      {bounds.size.length().toFixed(2)} meters
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Model Center:</span>
                    <span className="text-gray-200">
                      ({bounds.center.x.toFixed(2)}, {bounds.center.y.toFixed(2)}, {bounds.center.z.toFixed(2)})m
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Scene Min:</span>
                    <span className="text-gray-300">
                      ({bounds.min.x.toFixed(1)}, {bounds.min.y.toFixed(1)}, {bounds.min.z.toFixed(1)})
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Scene Max:</span>
                    <span className="text-gray-300">
                      ({bounds.max.x.toFixed(1)}, {bounds.max.y.toFixed(1)}, {bounds.max.z.toFixed(1)})
                    </span>
                  </div>
                </div>

                {/* Confidence Badges */}
                <div className="mt-2.5 pt-2 border-t border-gray-800/80 flex flex-wrap gap-1.5">
                  <span className="px-2 py-0.5 bg-emerald-950/80 border border-emerald-600/40 text-emerald-400 rounded text-[10px]">
                    SfM: {metadata?.sfm_confidence || "VALIDATED"}
                  </span>
                  <span className="px-2 py-0.5 bg-teal-950/80 border border-teal-600/40 text-teal-300 rounded text-[10px]">
                    Metric: {metadata?.metric_confidence || "METRIC 1:1"}
                  </span>
                  <span className="px-2 py-0.5 bg-blue-950/80 border border-blue-600/40 text-blue-300 rounded text-[10px]">
                    Frame: LOCAL_METRIC
                  </span>
                </div>

                {/* Layer Toggles */}
                <div className="mt-3 pt-2 border-t border-gray-800/80 grid grid-cols-2 gap-1.5 text-[10px]">
                  <label className="flex items-center gap-1.5 cursor-pointer text-gray-300 hover:text-white">
                    <input
                      type="checkbox"
                      checked={showCenterMarker}
                      onChange={(e) => setShowCenterMarker(e.target.checked)}
                      className="rounded accent-cyan-500"
                    />
                    Model Center
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer text-gray-300 hover:text-white">
                    <input
                      type="checkbox"
                      checked={showOriginMarker}
                      onChange={(e) => setShowOriginMarker(e.target.checked)}
                      className="rounded accent-rose-500"
                    />
                    Scene Origin
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer text-gray-300 hover:text-white">
                    <input
                      type="checkbox"
                      checked={showBoundingBox}
                      onChange={(e) => setShowBoundingBox(e.target.checked)}
                      className="rounded accent-teal-500"
                    />
                    Bounding Box
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer text-gray-300 hover:text-white">
                    <input
                      type="checkbox"
                      checked={showAxes}
                      onChange={(e) => setShowAxes(e.target.checked)}
                      className="rounded accent-amber-500"
                    />
                    XYZ Axes
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Dense Depth Drawer (Split View) */}
          {showDepthPanel && (
            <div className="w-96 bg-gray-900 border border-gray-800 rounded-2xl p-4 flex flex-col shadow-2xl backdrop-blur-md overflow-y-auto max-h-[85vh]">
              <div className="flex items-center justify-between pb-3 border-b border-gray-800 mb-3">
                <div className="flex items-center gap-2">
                  <Layers className="w-4 h-4 text-amber-400" />
                  <h3 className="font-bold text-sm text-white">Dense Depth Analysis</h3>
                </div>
                <button
                  onClick={() => setShowDepthPanel(false)}
                  className="p-1 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-white transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {loadingDepth ? (
                <div className="py-12 flex flex-col items-center justify-center text-gray-400">
                  <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin mb-2"></div>
                  <p className="text-xs">Loading depth metrics...</p>
                </div>
              ) : depthData ? (
                <div className="flex flex-col gap-4">
                  {/* Summary Metric Badges */}
                  <div className="grid grid-cols-2 gap-2 bg-gray-950/60 p-3 rounded-xl border border-gray-800/80">
                    <div>
                      <span className="text-[10px] text-gray-400 uppercase tracking-wider">Mean Depth</span>
                      <p className="text-base font-bold text-teal-300">{depthData.overall_scene_mean_depth_m} m</p>
                    </div>
                    <div>
                      <span className="text-[10px] text-gray-400 uppercase tracking-wider">Depth Range</span>
                      <p className="text-xs font-semibold text-gray-200 mt-1">
                        {depthData.overall_scene_min_depth_m}m – {depthData.overall_scene_max_depth_m}m
                      </p>
                    </div>
                    <div className="mt-1">
                      <span className="text-[10px] text-gray-400 uppercase tracking-wider">Confidence</span>
                      <p className="text-sm font-bold text-emerald-400">{depthData.overall_high_confidence_pct}%</p>
                    </div>
                    <div className="mt-1">
                      <span className="text-[10px] text-gray-400 uppercase tracking-wider">Keyframes</span>
                      <p className="text-sm font-bold text-amber-400">{depthData.total_keyframes}</p>
                    </div>
                  </div>

                  {/* Frame Navigator */}
                  {frames.length > 0 && currentFrame && (
                    <div className="flex flex-col gap-2 bg-gray-950/40 p-3 rounded-xl border border-gray-800">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-gray-300">
                          Frame {currentFrame.keyframe_index} / {frames.length}
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setSelectedFrameIdx(Math.max(0, selectedFrameIdx - 1))}
                            disabled={selectedFrameIdx === 0}
                            className="p-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-30 rounded text-gray-300 transition-colors"
                          >
                            <ChevronLeft className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => setSelectedFrameIdx(Math.min(frames.length - 1, selectedFrameIdx + 1))}
                            disabled={selectedFrameIdx === frames.length - 1}
                            className="p-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-30 rounded text-gray-300 transition-colors"
                          >
                            <ChevronRight className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {/* Display Mode Tabs */}
                      <div className="flex bg-gray-900 rounded-lg p-1 gap-1 border border-gray-800 text-[11px]">
                        <button
                          onClick={() => setViewMode("depth")}
                          className={`flex-1 py-1 rounded font-medium transition-colors ${
                            viewMode === "depth" ? "bg-amber-600 text-white" : "text-gray-400 hover:text-white"
                          }`}
                        >
                          Depth Map
                        </button>
                        <button
                          onClick={() => setViewMode("rgb")}
                          className={`flex-1 py-1 rounded font-medium transition-colors ${
                            viewMode === "rgb" ? "bg-teal-600 text-white" : "text-gray-400 hover:text-white"
                          }`}
                        >
                          RGB Frame
                        </button>
                        <button
                          onClick={() => setViewMode("confidence")}
                          className={`flex-1 py-1 rounded font-medium transition-colors ${
                            viewMode === "confidence" ? "bg-cyan-600 text-white" : "text-gray-400 hover:text-white"
                          }`}
                        >
                          Confidence
                        </button>
                      </div>

                      {/* Current Image Viewer */}
                      <div className="relative rounded-lg overflow-hidden border border-gray-800 bg-black aspect-video flex items-center justify-center">
                        <img
                          src={`http://localhost:8000/uploads/local_user/${projectName}/${
                            viewMode === "depth"
                              ? currentFrame.depth_image
                              : viewMode === "confidence"
                              ? currentFrame.confidence_image
                              : currentFrame.filename
                          }`}
                          alt={`Frame ${currentFrame.keyframe_index}`}
                          className="w-full h-full object-contain"
                          onError={(e) => {
                            e.target.style.display = "none";
                          }}
                        />
                      </div>

                      {/* Per-Frame Depth Metrics */}
                      <div className="grid grid-cols-2 gap-1.5 text-[11px] pt-1">
                        <div className="flex justify-between bg-gray-900/60 p-1.5 rounded">
                          <span className="text-gray-400">Mean:</span>
                          <span className="text-teal-300 font-semibold">{currentFrame.mean_depth_m}m</span>
                        </div>
                        <div className="flex justify-between bg-gray-900/60 p-1.5 rounded">
                          <span className="text-gray-400">Median:</span>
                          <span className="text-gray-200 font-semibold">{currentFrame.median_depth_m}m</span>
                        </div>
                        <div className="flex justify-between bg-gray-900/60 p-1.5 rounded">
                          <span className="text-gray-400">High Conf:</span>
                          <span className="text-emerald-400 font-semibold">{currentFrame.high_confidence_percent}%</span>
                        </div>
                        <div className="flex justify-between bg-gray-900/60 p-1.5 rounded">
                          <span className="text-gray-400">Std Dev:</span>
                          <span className="text-gray-300 font-semibold">{currentFrame.depth_std_m}m</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="py-12 flex flex-col items-center justify-center text-gray-500">
                  <Layers className="w-10 h-10 mb-2 opacity-30" />
                  <p className="text-xs">No dense depth analysis available for this project.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default Rendering;
