import {
  HandLandmarker,
  FaceLandmarker,
  FilesetResolver,
} from "@mediapipe/tasks-vision";

// Gracefully intercept and suppress third-party MediaPipe WebAssembly console info logs ("XNNPACK delegate", etc.)
const originalInfo = console.info;
console.info = function (...args) {
  if (
    args[0] &&
    typeof args[0] === "string" &&
    (args[0].includes("XNNPACK delegate") ||
      args[0].includes("TensorFlow Lite"))
  ) {
    return;
  }
  originalInfo.apply(console, args);
};

const originalLog = console.log;
console.log = function (...args) {
  if (
    args[0] &&
    typeof args[0] === "string" &&
    (args[0].includes("XNNPACK delegate") ||
      args[0].includes("TensorFlow Lite"))
  ) {
    return;
  }
  originalLog.apply(console, args);
};

export class VisionEngine {
  private handLandmarker: HandLandmarker | null = null;
  private faceLandmarker: FaceLandmarker | null = null;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  public isReady = false;

  public async init() {
    if (this.isReady) return;

    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/wasm",
    );

    this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 2,
    });

    this.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numFaces: 1,
    });

    this.isReady = true;
  }

  public async startVideo() {
    if (this.video) return;

    this.video = document.createElement("video");
    this.video.autoplay = true;
    this.video.playsInline = true;
    // Don't use display: none, it breaks video rendering in some browsers
    this.video.style.position = "absolute";
    this.video.style.opacity = "0";
    this.video.style.width = "1px";
    this.video.style.height = "1px";
    document.body.appendChild(this.video);

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
      });
      this.video.srcObject = this.stream;
      await new Promise((resolve) => (this.video!.onloadeddata = resolve));
      await this.video.play();
    } catch (e) {
      console.error("Error accessing webcam:", e);
      if (this.video.parentNode) {
        this.video.parentNode.removeChild(this.video);
      }
      this.video = null;
    }
  }

  public stopVideo() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.video) {
      if (this.video.parentNode) {
        this.video.parentNode.removeChild(this.video);
      }
      this.video = null;
    }
  }

  private lastTimestamp = -1;

  public getLandmarks(timestampMs: number) {
    if (
      !this.isReady ||
      !this.video ||
      this.video.readyState < 2 ||
      this.video.videoWidth === 0
    ) {
      return { hands: [], face: null };
    }

    // Ensure timestamp is strictly increasing for MediaPipe
    let ts = Math.floor(timestampMs);
    if (ts <= this.lastTimestamp) {
      ts = this.lastTimestamp + 1;
    }
    this.lastTimestamp = ts;

    try {
      const hands = this.handLandmarker!.detectForVideo(this.video, ts);
      const face = this.faceLandmarker!.detectForVideo(this.video, ts);

      // Return hand positions and check pinch status
      const handData = (hands.landmarks || []).map((lm) => {
        const thumb = lm[4];
        const index = lm[8];
        const palm = lm[9]; // Middle finger base, more stable than index tip
        const dx = thumb.x - index.x;
        const dy = thumb.y - index.y;
        const dz = thumb.z - index.z;
        const pinchDist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        // Experimentally determined threshold for pinching
        const isPinched = pinchDist < 0.08;

        return { x: palm.x, y: palm.y, isPinched };
      });

      // Face has 478 landmarks. Nose tip is 1. Left Eye is 33. Right Eye is 263.
      let faceData = null;
      if (face.faceLandmarks && face.faceLandmarks.length > 0) {
        const lm = face.faceLandmarks[0];
        const nose = lm[1];
        const leftEye = lm[33];
        const rightEye = lm[263];

        // Calculate Roll (tilt)
        const dx = rightEye.x - leftEye.x;
        const dy = rightEye.y - leftEye.y;
        const roll = Math.atan2(dy, dx);

        // Calculate Yaw (turning) by comparing nose horizontal position relative to eyes center
        const cx = (leftEye.x + rightEye.x) / 2.0;
        const eyeDist = Math.sqrt(dx * dx + dy * dy);
        // Scale yaw up to give a distinct rotational effect
        const yaw = (nose.x - cx) / (eyeDist + 0.001);

        // Combine into a complex phase angle mapping
        const phaseAngle = roll + yaw * 2.0;

        faceData = {
          x: nose.x,
          y: nose.y,
          phaseRe: Math.cos(phaseAngle),
          phaseIm: Math.sin(phaseAngle),
        };
      }

      return {
        hands: handData,
        face: faceData,
      };
    } catch (e) {
      console.warn(
        "Hand/Face Landmarker Error (can be ignored if occasional):",
        e,
      );
      return { hands: [], face: null };
    }
  }

  public destroy() {
    this.stopVideo();
    this.handLandmarker?.close();
    this.faceLandmarker?.close();
  }
}
