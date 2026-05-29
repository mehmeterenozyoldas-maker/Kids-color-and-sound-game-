/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { WaveEngine } from "./lib/webgl/WaveEngine";
import { AudioEngine } from "./lib/audio/AudioEngine";
import { VisionEngine } from "./lib/vision/VisionEngine";
import {
  Settings2,
  Volume2,
  VolumeX,
  Maximize,
  Play,
  Camera,
  CameraOff,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<WaveEngine | null>(null);
  const audioRef = useRef<AudioEngine | null>(null);
  const visionRef = useRef<VisionEngine | null>(null);
  const reqRef = useRef<number>(0);

  const [mounted, setMounted] = useState(false);
  const [showUI, setShowUI] = useState(true);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  // Connection Initialization Options
  const [initWithAudio, setInitWithAudio] = useState(true);
  const [initWithVision, setInitWithVision] = useState(true);
  const [isInitializing, setIsInitializing] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  // Simulation Params
  const [damping, setDamping] = useState(0.005);
  const [waveSpeed, setWaveSpeed] = useState(0.3);
  const [brightness, setBrightness] = useState(1.0);
  const [chroma, setChroma] = useState(1.0);
  const [simScale, setSimScale] = useState(0.5);

  // Interaction State
  const interactionState = useRef({
    x: -1,
    y: -1,
    force: 0,
    phaseRe: 1,
    phaseIm: 0,
    radius: 20,
  });

  const pinchStates = useRef<boolean[]>([]);

  const initializeSystem = async () => {
    setIsInitializing(true);
    setInitError(null);
    try {
      if (initWithAudio) {
        if (!audioRef.current) {
          audioRef.current = new AudioEngine();
        }
        await audioRef.current.init();
        setAudioEnabled(true);
      } else {
        setAudioEnabled(false);
      }

      if (initWithVision) {
        if (!visionRef.current) {
          visionRef.current = new VisionEngine();
        }
        await visionRef.current.init();
        await visionRef.current.startVideo();
        setVisionEnabled(true);
      } else {
        setVisionEnabled(false);
      }

      setIsPlaying(true);
    } catch (err: any) {
      console.error("System initialization failed:", err);
      setInitError("Failed to initialize selected modules. Please ensure camera access permissions are active and granted.");
    } finally {
      setIsInitializing(false);
    }
  };

  const toggleAudio = () => {
    if (audioEnabled) {
      audioRef.current?.setVolume(0);
      setAudioEnabled(false);
    } else {
      audioRef.current?.setVolume(0.5);
      setAudioEnabled(true);
    }
  };

  const toggleVision = async () => {
    if (visionEnabled) {
      visionRef.current?.stopVideo();
      setVisionEnabled(false);
    } else {
      if (!visionRef.current) {
        visionRef.current = new VisionEngine();
      }
      await visionRef.current.init();
      await visionRef.current.startVideo();
      setVisionEnabled(true);
    }
  };

  useEffect(() => {
    if (!canvasRef.current) return;

    const dpr = window.devicePixelRatio || 1;
    // Set initial size
    canvasRef.current.width = window.innerWidth * dpr;
    canvasRef.current.height = window.innerHeight * dpr;

    try {
      engineRef.current = new WaveEngine(canvasRef.current, simScale);
      setMounted(true);
    } catch (e) {
      console.error(e);
      setMounted(false);
      return;
    }

    const onResize = () => {
      if (!canvasRef.current || !engineRef.current) return;
      canvasRef.current.width = window.innerWidth * dpr;
      canvasRef.current.height = window.innerHeight * dpr;
      engineRef.current.resize(
        canvasRef.current.width,
        canvasRef.current.height,
        simScale,
      );
    };

    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      engineRef.current?.destroy();
      visionRef.current?.destroy();
    };
  }, [simScale]);

  const loop = useCallback(() => {
    if (!engineRef.current || !mounted || !isPlaying) {
      reqRef.current = requestAnimationFrame(loop);
      return;
    }

    // 1 step of simulation
    // Run multiple steps per frame to increase wave speed naturally without explosion
    const tOffset = performance.now();
    let currentInteractions: any[] = [];

    if (interactionState.current.force > 0) {
      currentInteractions.push(interactionState.current);
    }

    if (visionEnabled && visionRef.current?.isReady) {
      const marks = visionRef.current.getLandmarks(tOffset);

      marks.hands.forEach((pt: any, i: number) => {
        // Detect pinch start and trigger sound chime
        const isPinchStart = pt.isPinched && !pinchStates.current[i];
        if (isPinchStart) {
          if (audioEnabled && audioRef.current) {
            audioRef.current.triggerChime(1.0 - pt.x, pt.y, 1.0);
          }
        }
        pinchStates.current[i] = pt.isPinched;

        // Mimic mouse: Pinch Start (click) -> force 2.0; Pinch Hold (drag) -> force 0.8; Open Hand (hover) -> force 0
        const force = isPinchStart ? 2.0 : pt.isPinched ? 0.8 : 0;
        const radius = isPinchStart ? 40 : pt.isPinched ? 20 : 0;
        const mappedX = 1.0 - pt.x; // mirror

        const tSpeed = isPinchStart ? 0.002 : 0.005;

        currentInteractions.push({
          x: mappedX,
          y: pt.y,
          force,
          radius,
          phaseRe: Math.cos(tOffset * tSpeed),
          phaseIm: Math.sin(tOffset * tSpeed),
        });

        // Update DOM overlay
        const cursor = document.getElementById(`cursor-hand-${i}`);
        if (cursor) {
          cursor.style.display = "block";
          cursor.style.left = `${mappedX * 100}%`;
          cursor.style.top = `${pt.y * 100}%`;
          cursor.className = `absolute w-12 h-12 -ml-6 -mt-6 rounded-full border-2 transition-all duration-75 pointer-events-none z-50 ${pt.isPinched ? "border-white bg-white/20 scale-75 shadow-[0_0_20px_rgba(255,255,255,0.5)]" : "border-gray-500/50 bg-black/10 border-dashed scale-125"}`;
        }
      });
      // Hide unused hand cursors
      for (let i = marks.hands.length; i < 4; i++) {
        const cursor = document.getElementById(`cursor-hand-${i}`);
        if (cursor) cursor.style.display = "none";
        pinchStates.current[i] = false;
      }

      if (marks.face) {
        const mappedX = 1.0 - marks.face.x; // mirror
        // Make the face phase time-varying, offset by its fixed pose angle, to ensure it oscillates!
        const dynamicPhaseAngle =
          Math.atan2(marks.face.phaseIm, marks.face.phaseRe) + tOffset * 0.001;

        currentInteractions.push({
          x: mappedX,
          y: marks.face.y,
          force: 0.8, // Light ripple anchor
          radius: 35,
          phaseRe: Math.cos(dynamicPhaseAngle),
          phaseIm: Math.sin(dynamicPhaseAngle),
        });

        const cursor = document.getElementById(`cursor-face`);
        if (cursor) {
          cursor.style.display = "block";
          cursor.style.left = `${mappedX * 100}%`;
          cursor.style.top = `${marks.face.y * 100}%`;
          // Map phase angle to hue
          const hue =
            (((dynamicPhaseAngle * (180 / Math.PI)) % 360) + 360) % 360;
          cursor.style.borderColor = `hsl(${hue}, 100%, 70%)`;
        }
      } else {
        const cursor = document.getElementById(`cursor-face`);
        if (cursor) cursor.style.display = "none";
      }
    } else {
      // hide all if disabled
      for (let i = 0; i < 4; i++) {
        const c = document.getElementById(`cursor-hand-${i}`);
        if (c) c.style.display = "none";
        pinchStates.current[i] = false;
      }
      const cf = document.getElementById(`cursor-face`);
      if (cf) cf.style.display = "none";
    }

    const steps = 2;
    for (let i = 0; i < steps; i++) {
      // Only apply force on the first step
      const activeInteractions = i === 0 ? currentInteractions : [];

      engineRef.current.step(damping, waveSpeed, activeInteractions);
    }

    // Decay the interaction force
    if (interactionState.current.force > 0) {
      interactionState.current.force *= 0.5;
      if (interactionState.current.force < 0.01)
        interactionState.current.force = 0;
    }

    engineRef.current.render(brightness, chroma);

    // Ping drone audio
    if (audioEnabled && audioRef.current) {
      audioRef.current.updateDroneField(Math.random() * 0.1);
    }

    reqRef.current = requestAnimationFrame(loop);
  }, [
    mounted,
    isPlaying,
    damping,
    waveSpeed,
    brightness,
    chroma,
    audioEnabled,
  ]);

  useEffect(() => {
    reqRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(reqRef.current);
  }, [loop]);

  const handlePointerStart = (e: React.PointerEvent) => {
    if (!isPlaying) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    // Inject complex phase based on time
    const t = performance.now() * 0.002;

    interactionState.current = {
      x,
      y,
      force: 2.0,
      phaseRe: Math.cos(t),
      phaseIm: Math.sin(t),
      radius: 40,
    };

    if (audioEnabled && audioRef.current) {
      audioRef.current.triggerChime(x, y, 1.0);
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isPlaying || e.buttons !== 1) return; // Only if mouse is down
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    const t = performance.now() * 0.005;

    interactionState.current = {
      x,
      y,
      force: 0.8, // Continuous lighter force
      phaseRe: Math.cos(t),
      phaseIm: Math.sin(t),
      radius: 20,
    };
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  const clearCanvas = () => {
    engineRef.current?.clearStates();
  };

  return (
    <div className="relative w-full h-screen bg-black overflow-hidden font-sans select-none touch-none">
      <canvas
        ref={canvasRef}
        className="block w-full h-full cursor-crosshair"
        onPointerDown={handlePointerStart}
        onPointerMove={handlePointerMove}
        style={{ width: "100vw", height: "100vh" }}
      />

      {/* Start Screen Overlay */}
      {!isPlaying && (
        <div className="absolute inset-0 bg-black/80 flex items-center justify-center backdrop-blur-sm z-50 transition-opacity">
          <div className="text-center p-8 md:p-12 max-w-2xl flex flex-col items-center">
            <h1 className="text-5xl font-mono text-white tracking-widest uppercase mb-4 opacity-90 font-light">
              Resonant Scales
            </h1>
            <p className="text-gray-400 font-mono text-sm mb-10 uppercase tracking-wide leading-relaxed">
              Non-Local Interference Simulator // Node 0x91
              <br />A real-time complex scalar field simulation driven by
              fractal Laplacians.
            </p>

            {/* Connection Options */}
            <div className="w-full max-w-md mx-auto mb-8 space-y-3 text-left">
              <div
                onClick={() => !isInitializing && setInitWithAudio(!initWithAudio)}
                className={`flex items-center gap-4 p-4 border rounded-xl cursor-pointer transition-all duration-300 ${
                  initWithAudio
                    ? "border-white/30 bg-white/5 text-white"
                    : "border-white/10 bg-black/40 text-gray-500 hover:border-white/20"
                }`}
              >
                <div className={`w-5 h-5 rounded border flex items-center justify-center transition-all ${
                  initWithAudio ? "border-white bg-white" : "border-white/20"
                }`}>
                  {initWithAudio && <span className="w-2.5 h-2.5 bg-black rounded-[1px]" />}
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-mono uppercase tracking-wider font-semibold">Resonant Audio Engine</h3>
                  <p className="text-xs text-gray-400 mt-0.5 font-mono leading-normal">
                    Generates real-time spatialized soundscapes in response to wave interactions.
                  </p>
                </div>
              </div>

              <div
                onClick={() => !isInitializing && setInitWithVision(!initWithVision)}
                className={`flex items-center gap-4 p-4 border rounded-xl cursor-pointer transition-all duration-300 ${
                  initWithVision
                    ? "border-white/30 bg-white/5 text-white"
                    : "border-white/10 bg-black/40 text-gray-500 hover:border-white/20"
                }`}
              >
                <div className={`w-5 h-5 rounded border flex items-center justify-center transition-all ${
                  initWithVision ? "border-white bg-white" : "border-white/20"
                }`}>
                  {initWithVision && <span className="w-2.5 h-2.5 bg-black rounded-[1px]" />}
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-mono uppercase tracking-wider font-semibold flex items-center gap-2">
                    Webcam Gesture Control
                    <span className="text-[10px] bg-white/10 text-white/80 px-1.5 py-0.5 rounded font-normal lowercase tracking-normal">
                      mediapipe
                    </span>
                  </h3>
                  <p className="text-xs text-gray-400 mt-0.5 font-mono leading-normal">
                    Track hands (pinch/drag) and face angles dynamically using your camera.
                  </p>
                </div>
              </div>
            </div>

            {initError && (
              <p className="text-red-400 font-mono text-xs mb-6 max-w-md mx-auto leading-relaxed">
                {initError}
              </p>
            )}

            <button
              onClick={initializeSystem}
              disabled={isInitializing}
              className="px-8 flex-none py-4 border border-white/20 hover:border-white hover:bg-white hover:text-black text-white uppercase tracking-[0.2em] transition-all duration-500 flex items-center gap-4 mx-auto disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isInitializing ? (
                <>
                  <div className="w-5 h-5 border-2 border-dashed border-current rounded-full animate-spin" />
                  Calibrating System...
                </>
              ) : (
                <>
                  <Play className="w-5 h-5" />
                  Initialize Connection
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Vision Cursors */}
      <div id="cursor-hand-0" style={{ display: "none" }}></div>
      <div id="cursor-hand-1" style={{ display: "none" }}></div>
      <div id="cursor-hand-2" style={{ display: "none" }}></div>
      <div id="cursor-hand-3" style={{ display: "none" }}></div>
      <div
        id="cursor-face"
        style={{ display: "none" }}
        className="absolute w-24 h-24 -ml-12 -mt-12 rounded-full border border-dashed border-white transition-colors pointer-events-none"
      ></div>

      {/* Persistent UI Controls */}
      <AnimatePresence>
        {showUI && isPlaying && (
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="absolute top-6 left-6 w-80 bg-black/40 backdrop-blur-md border border-white/10 rounded-xl text-white p-6 shadow-2xl z-40"
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-sm font-mono tracking-widest text-gray-300 uppercase">
                Operator Terminal
              </h2>
              <button
                onClick={() => setShowUI(false)}
                className="text-gray-500 hover:text-white transition-colors"
              >
                <Settings2 className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-6">
              <div className="space-y-2">
                <div className="flex justify-between text-xs font-mono text-gray-400 uppercase tracking-wide">
                  <span>Damping</span>
                  <span>{damping.toFixed(4)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="0.05"
                  step="0.001"
                  value={damping}
                  onChange={(e) => setDamping(parseFloat(e.target.value))}
                  className="w-full accent-white h-1 bg-white/20 appearance-none rounded-full"
                />
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-xs font-mono text-gray-400 uppercase tracking-wide">
                  <span>Wave Speed (c)</span>
                  <span>{waveSpeed.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0.01"
                  max="0.8"
                  step="0.01"
                  value={waveSpeed}
                  onChange={(e) => setWaveSpeed(parseFloat(e.target.value))}
                  className="w-full accent-white h-1 bg-white/20 appearance-none rounded-full"
                />
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-xs font-mono text-gray-400 uppercase tracking-wide">
                  <span>Amp -&gt; Brightness</span>
                  <span>{brightness.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="5.0"
                  step="0.1"
                  value={brightness}
                  onChange={(e) => setBrightness(parseFloat(e.target.value))}
                  className="w-full accent-white h-1 bg-white/20 appearance-none rounded-full"
                />
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-xs font-mono text-gray-400 uppercase tracking-wide">
                  <span>Chroma Saturation</span>
                  <span>{chroma.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="2.0"
                  step="0.1"
                  value={chroma}
                  onChange={(e) => setChroma(parseFloat(e.target.value))}
                  className="w-full accent-white h-1 bg-white/20 appearance-none rounded-full"
                />
              </div>

              <div className="space-y-2 mt-4 pt-4 border-t border-white/10">
                <button
                  onClick={clearCanvas}
                  className="w-full py-2 border border-white/20 hover:bg-white/10 transition-colors uppercase tracking-widest text-xs font-mono text-gray-300"
                >
                  Purge System Memory
                </button>
              </div>
            </div>

            {visionEnabled && (
              <div className="mt-8 space-y-4 border-t border-white/10 pt-6">
                <h3 className="text-xs font-mono tracking-widest text-gray-400 uppercase">
                  Interaction Map
                </h3>
                <ul className="text-xs font-mono text-gray-400 space-y-3 leading-relaxed">
                  <li className="flex gap-3">
                    <span className="text-white w-20 flex-none">Face:</span>{" "}
                    <span className="text-gray-500">
                      Central anchor / Continuous ripple
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="text-white w-20 flex-none">
                      Head Tilt:
                    </span>{" "}
                    <span className="text-gray-500">
                      Controls anchor phase / color
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="text-white w-20 flex-none">Pinch:</span>{" "}
                    <span className="text-gray-500">
                      Creates strong ripples (like clicking)
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="text-white w-20 flex-none">
                      Drag Hand:
                    </span>{" "}
                    <span className="text-gray-500">
                      Leaves a trail while pinching (like moving mouse)
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="text-white w-20 flex-none">
                      Open Hand:
                    </span>{" "}
                    <span className="text-gray-500">
                      Hovering without injecting waves
                    </span>
                  </li>
                </ul>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Action Buttons */}
      <div className="absolute bottom-6 right-6 flex gap-4 z-40">
        {!showUI && isPlaying && (
          <button
            onClick={() => setShowUI(true)}
            className="w-12 h-12 bg-black/40 backdrop-blur-md rounded-full border border-white/10 flex items-center justify-center text-gray-400 hover:text-white hover:border-white/40 transition-all font-mono"
            title="Open Control Panel"
          >
            <Settings2 className="w-5 h-5" />
          </button>
        )}
        {isPlaying && (
          <>
            <button
              onClick={toggleAudio}
              className="w-12 h-12 bg-black/40 backdrop-blur-md rounded-full border border-white/10 flex items-center justify-center text-gray-400 hover:text-white hover:border-white/40 transition-all"
              title="Toggle Audio"
            >
              {audioEnabled ? (
                <Volume2 className="w-5 h-5" />
              ) : (
                <VolumeX className="w-5 h-5" />
              )}
            </button>
            <button
              onClick={toggleVision}
              className="w-12 h-12 bg-black/40 backdrop-blur-md rounded-full border border-white/10 flex items-center justify-center text-gray-400 hover:text-white hover:border-white/40 transition-all"
              title="Toggle Camera Tracking"
            >
              {visionEnabled ? (
                <Camera className="w-5 h-5" />
              ) : (
                <CameraOff className="w-5 h-5" />
              )}
            </button>
            <button
              onClick={toggleFullscreen}
              className="w-12 h-12 bg-black/40 backdrop-blur-md rounded-full border border-white/10 flex items-center justify-center text-gray-400 hover:text-white hover:border-white/40 transition-all"
              title="Fullscreen"
            >
              <Maximize className="w-4 h-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
