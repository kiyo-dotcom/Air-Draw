// AirDraw — Hand Gesture Studio
// Main Application Logic

import { HandLandmarker, FilesetResolver, DrawingUtils } from "@mediapipe/tasks-vision";

// ===== Constants =====
const FINGER_TIPS = [4, 8, 12, 16, 20];
const FINGER_PIPS = [3, 6, 10, 14, 18];
const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]
];

// ===== State =====
const state = {
    tool: 'draw',
    color: '#ffffff',
    brushSize: 3,
    eraseSize: 30,
    isRunning: false,
    prevPoint: null,
    gesture: 'IDLE',
    lastGesture: 'IDLE',
    gestureStartTime: 0,
    undoStack: [],
    maxUndo: 20,
    undoCooldown: false,
    pendingText: null,
    textPlacing: false,
    fps: 0,
    frameCount: 0,
    lastFpsTime: performance.now(),
    canvasWidth: 1280,
    canvasHeight: 720,
    smoothX: 0,
    smoothY: 0,
    smoothing: 0.45,
};

// ===== DOM Elements =====
const $ = id => document.getElementById(id);
const loadingScreen = $('loading-screen');
const loadProgress = $('load-progress');
const tutorialOverlay = $('tutorial-overlay');
const textModal = $('text-modal');
const textInput = $('text-input');
const webcamEl = $('webcam');
const videoCanvas = $('video-canvas');
const drawingCanvas = $('drawing-canvas');
const effectsCanvas = $('effects-canvas');
const gestureIndicator = $('gesture-indicator');
const gestureIcon = $('gesture-icon');
const gestureLabel = $('gesture-label');
const cursorIndicator = $('cursor-indicator');
const toastEl = $('toast');
const fpsCounter = $('fps-counter');
const handsCount = $('hands-count');
const gestureStatus = $('gesture-status');

const videoCtx = videoCanvas.getContext('2d');
const drawCtx = drawingCanvas.getContext('2d');
const fxCtx = effectsCanvas.getContext('2d');

let handLandmarker = null;

// ===== Initialization =====
async function init() {
    setProgress(10);
    await setupMediaPipe();
    setProgress(70);
    setupUI();
    setProgress(85);
    await setupCamera();
    setProgress(100);

    setTimeout(() => {
        loadingScreen.classList.add('fade-out');
        setTimeout(() => { loadingScreen.style.display = 'none'; }, 600);
        // Show tutorial on first visit
        if (!localStorage.getItem('airdraw_tutorial_seen')) {
            tutorialOverlay.classList.remove('hidden');
        }
        state.isRunning = true;
        processFrame();
    }, 400);
}

function setProgress(pct) {
    loadProgress.style.width = pct + '%';
}

// ===== MediaPipe Setup =====
async function setupMediaPipe() {
    const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
            delegate: "GPU"
        },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
    });
}

// ===== Camera Setup =====
async function setupCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
    });
    webcamEl.srcObject = stream;
    await new Promise(r => { webcamEl.onloadedmetadata = r; });
    webcamEl.play();
    state.canvasWidth = webcamEl.videoWidth;
    state.canvasHeight = webcamEl.videoHeight;
    [videoCanvas, drawingCanvas, effectsCanvas].forEach(c => {
        c.width = state.canvasWidth;
        c.height = state.canvasHeight;
    });
    gestureStatus.textContent = 'Camera active';
}

// ===== UI Setup =====
function setupUI() {
    // Tool buttons
    document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.tool = btn.dataset.tool;
            if (state.tool === 'text') openTextModal();
        });
    });

    // Color buttons
    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.color = btn.dataset.color;
        });
    });

    // Size buttons
    document.querySelectorAll('.size-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.brushSize = parseInt(btn.dataset.size);
        });
    });

    // Undo
    $('undo-btn').addEventListener('click', performUndo);

    // Clear
    $('clear-btn').addEventListener('click', () => {
        saveUndo();
        drawCtx.clearRect(0, 0, state.canvasWidth, state.canvasHeight);
        showToast('Canvas Cleared');
    });

    // Tutorial
    $('tutorial-close').addEventListener('click', () => {
        tutorialOverlay.classList.add('hidden');
        localStorage.setItem('airdraw_tutorial_seen', '1');
    });
    $('help-btn').addEventListener('click', () => tutorialOverlay.classList.remove('hidden'));

    // Text modal
    $('text-cancel').addEventListener('click', closeTextModal);
    $('text-confirm').addEventListener('click', confirmText);
    textInput.addEventListener('keydown', e => { if (e.key === 'Enter') confirmText(); });
}

function openTextModal() {
    textModal.classList.remove('hidden');
    textInput.value = '';
    textInput.focus();
}
function closeTextModal() {
    textModal.classList.add('hidden');
    state.pendingText = null;
    state.textPlacing = false;
    // Switch back to draw tool
    document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
    document.querySelector('.tool-btn[data-tool="draw"]').classList.add('active');
    state.tool = 'draw';
}
function confirmText() {
    const txt = textInput.value.trim();
    if (txt) {
        state.pendingText = txt;
        state.textPlacing = true;
        textModal.classList.add('hidden');
        showToast('Point with index finger & pinch to place text');
    }
}

// ===== Toast =====
let toastTimer = null;
function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2000);
}

// ===== Undo =====
function saveUndo() {
    const data = drawCtx.getImageData(0, 0, state.canvasWidth, state.canvasHeight);
    state.undoStack.push(data);
    if (state.undoStack.length > state.maxUndo) state.undoStack.shift();
}
function performUndo() {
    if (state.undoStack.length > 0) {
        drawCtx.putImageData(state.undoStack.pop(), 0, 0);
        showToast('Undo');
    }
}

// ===== Gesture Detection =====
function dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function isFingerUp(lm, idx) {
    // idx: 0=thumb, 1=index, 2=middle, 3=ring, 4=pinky
    if (idx === 0) {
        // Thumb: tip is farther from wrist than IP
        return dist(lm[4], lm[2]) > dist(lm[3], lm[2]) * 1.1;
    }
    return lm[FINGER_TIPS[idx]].y < lm[FINGER_PIPS[idx]].y;
}

function detectGesture(landmarks) {
    const fingers = [0, 1, 2, 3, 4].map(i => isFingerUp(landmarks, i));
    const [thumb, index, middle, ring, pinky] = fingers;
    const pinchDist = dist(landmarks[4], landmarks[8]);

    if (pinchDist < 0.06) return 'PINCH';
    if (index && !middle && !ring && !pinky) return 'DRAW';
    if (index && middle && !ring && !pinky) return 'ERASE';
    if (index && middle && ring && !pinky) return 'UNDO';
    if (index && middle && ring && pinky) return 'IDLE';
    if (!index && !middle && !ring && !pinky) return 'FIST';
    return 'IDLE';
}

// ===== Drawing =====
function drawLine(x, y) {
    if (!state.prevPoint) { state.prevPoint = { x, y }; return; }
    drawCtx.beginPath();
    drawCtx.moveTo(state.prevPoint.x, state.prevPoint.y);
    // Quadratic curve for smoothness
    const mx = (state.prevPoint.x + x) / 2;
    const my = (state.prevPoint.y + y) / 2;
    drawCtx.quadraticCurveTo(state.prevPoint.x, state.prevPoint.y, mx, my);
    drawCtx.strokeStyle = state.color;
    drawCtx.lineWidth = state.brushSize;
    drawCtx.lineCap = 'round';
    drawCtx.lineJoin = 'round';
    drawCtx.stroke();
    state.prevPoint = { x, y };
}

function eraseAt(x, y) {
    drawCtx.save();
    drawCtx.globalCompositeOperation = 'destination-out';
    drawCtx.beginPath();
    drawCtx.arc(x, y, state.eraseSize, 0, Math.PI * 2);
    drawCtx.fill();
    drawCtx.restore();
}

function placeText(x, y) {
    if (!state.pendingText) return;
    saveUndo();
    drawCtx.save();
    drawCtx.font = `bold 32px 'Outfit', sans-serif`;
    drawCtx.fillStyle = state.color;
    drawCtx.textAlign = 'center';
    drawCtx.textBaseline = 'middle';
    drawCtx.shadowColor = state.color;
    drawCtx.shadowBlur = 8;
    drawCtx.fillText(state.pendingText, x, y);
    drawCtx.restore();
    state.pendingText = null;
    state.textPlacing = false;
    showToast('Text placed!');
    // Switch back to draw
    document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
    document.querySelector('.tool-btn[data-tool="draw"]').classList.add('active');
    state.tool = 'draw';
}

// ===== Hand Drawing Effects =====
function drawHandSkeleton(landmarks, handedness) {
    const w = state.canvasWidth, h = state.canvasHeight;
    const isLeft = handedness === 'Left';
    const baseColor = isLeft ? '#6c5ce7' : '#00cec9';

    // Draw connections
    fxCtx.strokeStyle = baseColor;
    fxCtx.lineWidth = 2;
    fxCtx.globalAlpha = 0.6;
    for (const [a, b] of HAND_CONNECTIONS) {
        const ax = (1 - landmarks[a].x) * w, ay = landmarks[a].y * h;
        const bx = (1 - landmarks[b].x) * w, by = landmarks[b].y * h;
        fxCtx.beginPath();
        fxCtx.moveTo(ax, ay);
        fxCtx.lineTo(bx, by);
        fxCtx.stroke();
    }

    // Draw landmarks
    fxCtx.globalAlpha = 1;
    for (let i = 0; i < landmarks.length; i++) {
        const x = (1 - landmarks[i].x) * w;
        const y = landmarks[i].y * h;
        const isTip = FINGER_TIPS.includes(i);
        const radius = isTip ? 5 : 3;

        fxCtx.beginPath();
        fxCtx.arc(x, y, radius, 0, Math.PI * 2);
        fxCtx.fillStyle = isTip ? '#fff' : baseColor;
        fxCtx.fill();

        if (isTip) {
            fxCtx.beginPath();
            fxCtx.arc(x, y, radius + 4, 0, Math.PI * 2);
            fxCtx.strokeStyle = baseColor;
            fxCtx.lineWidth = 1.5;
            fxCtx.stroke();
        }
    }
}

function drawIronManEffect(hand1, hand2) {
    const w = state.canvasWidth, h = state.canvasHeight;
    const time = performance.now() * 0.003;

    for (let i = 0; i < FINGER_TIPS.length; i++) {
        const tipIdx = FINGER_TIPS[i];
        const x1 = (1 - hand1[tipIdx].x) * w, y1 = hand1[tipIdx].y * h;
        const x2 = (1 - hand2[tipIdx].x) * w, y2 = hand2[tipIdx].y * h;

        // Energy beam
        const grad = fxCtx.createLinearGradient(x1, y1, x2, y2);
        grad.addColorStop(0, '#6c5ce7');
        grad.addColorStop(0.5, '#00cec9');
        grad.addColorStop(1, '#6c5ce7');

        fxCtx.save();
        fxCtx.globalAlpha = 0.4 + Math.sin(time + i) * 0.2;
        fxCtx.strokeStyle = grad;
        fxCtx.lineWidth = 2 + Math.sin(time * 2 + i) * 1;
        fxCtx.shadowColor = '#00cec9';
        fxCtx.shadowBlur = 15;
        fxCtx.beginPath();
        fxCtx.moveTo(x1, y1);

        // Wavy line
        const mx = (x1 + x2) / 2 + Math.sin(time + i * 2) * 20;
        const my = (y1 + y2) / 2 + Math.cos(time + i * 2) * 20;
        fxCtx.quadraticCurveTo(mx, my, x2, y2);
        fxCtx.stroke();
        fxCtx.restore();

        // Glow dots at endpoints
        for (const [px, py] of [[x1, y1], [x2, y2]]) {
            fxCtx.save();
            fxCtx.globalAlpha = 0.6;
            const rGrad = fxCtx.createRadialGradient(px, py, 0, px, py, 12);
            rGrad.addColorStop(0, 'rgba(0, 206, 201, 0.8)');
            rGrad.addColorStop(1, 'rgba(108, 92, 231, 0)');
            fxCtx.fillStyle = rGrad;
            fxCtx.fillRect(px - 12, py - 12, 24, 24);
            fxCtx.restore();
        }
    }

    // Central energy orb between palms
    const cx1 = (1 - hand1[0].x) * w, cy1 = hand1[0].y * h;
    const cx2 = (1 - hand2[0].x) * w, cy2 = hand2[0].y * h;
    const cx = (cx1 + cx2) / 2, cy = (cy1 + cy2) / 2;
    const orbSize = 20 + Math.sin(time * 3) * 8;

    fxCtx.save();
    fxCtx.globalAlpha = 0.5;
    const orbGrad = fxCtx.createRadialGradient(cx, cy, 0, cx, cy, orbSize);
    orbGrad.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
    orbGrad.addColorStop(0.3, 'rgba(0, 206, 201, 0.6)');
    orbGrad.addColorStop(0.6, 'rgba(108, 92, 231, 0.3)');
    orbGrad.addColorStop(1, 'rgba(108, 92, 231, 0)');
    fxCtx.fillStyle = orbGrad;
    fxCtx.beginPath();
    fxCtx.arc(cx, cy, orbSize, 0, Math.PI * 2);
    fxCtx.fill();
    fxCtx.restore();
}

// ===== Update Gesture UI =====
const GESTURE_INFO = {
    DRAW: { icon: '☝️', label: 'Drawing', cls: 'draw' },
    ERASE: { icon: '✌️', label: 'Erasing', cls: 'erase' },
    UNDO: { icon: '🤟', label: 'Undo', cls: 'undo' },
    PINCH: { icon: '🤌', label: 'Pinch', cls: 'text' },
    FIST: { icon: '✊', label: 'Paused', cls: 'idle' },
    IDLE: { icon: '✋', label: 'Hover', cls: 'idle' },
};

function updateGestureUI(gesture, numHands) {
    const info = GESTURE_INFO[gesture] || GESTURE_INFO.IDLE;
    gestureIndicator.classList.remove('hidden', 'draw', 'erase', 'text', 'undo', 'idle');
    gestureIndicator.classList.add(info.cls);
    gestureIcon.textContent = info.icon;
    gestureLabel.textContent = info.label;
    handsCount.textContent = `Hands: ${numHands}`;
    gestureStatus.textContent = info.label;
}

function updateCursor(x, y, gesture) {
    if (gesture === 'DRAW' || gesture === 'ERASE' || gesture === 'PINCH') {
        cursorIndicator.classList.remove('hidden');
        cursorIndicator.style.left = x + 'px';
        cursorIndicator.style.top = y + 'px';
        cursorIndicator.className = gesture === 'ERASE' ? 'erasing' : 'drawing';
    } else {
        cursorIndicator.classList.add('hidden');
    }
}

// ===== Main Frame Loop =====
let lastFrameTime = 0;
function processFrame() {
    if (!state.isRunning) return;
    requestAnimationFrame(processFrame);

    const now = performance.now();
    // FPS counter
    state.frameCount++;
    if (now - state.lastFpsTime >= 1000) {
        state.fps = state.frameCount;
        state.frameCount = 0;
        state.lastFpsTime = now;
        fpsCounter.textContent = `FPS: ${state.fps}`;
    }

    if (webcamEl.readyState < 2) return;

    const w = state.canvasWidth, h = state.canvasHeight;

    // Draw mirrored video
    videoCtx.save();
    videoCtx.translate(w, 0);
    videoCtx.scale(-1, 1);
    videoCtx.drawImage(webcamEl, 0, 0, w, h);
    videoCtx.restore();
    // Slight dark overlay for better drawing visibility
    videoCtx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    videoCtx.fillRect(0, 0, w, h);

    // Clear effects
    fxCtx.clearRect(0, 0, w, h);

    // Run hand detection
    const results = handLandmarker.detectForVideo(webcamEl, now);
    const numHands = results.landmarks ? results.landmarks.length : 0;

    if (numHands === 0) {
        gestureIndicator.classList.add('hidden');
        cursorIndicator.classList.add('hidden');
        state.prevPoint = null;
        handsCount.textContent = 'Hands: 0';
        gestureStatus.textContent = 'Show your hand';
        return;
    }

    // Draw all hand skeletons
    for (let i = 0; i < numHands; i++) {
        const handedness = results.handedness?.[i]?.[0]?.categoryName || 'Right';
        drawHandSkeleton(results.landmarks[i], handedness);
    }

    // Iron Man effect for two hands
    if (numHands >= 2) {
        drawIronManEffect(results.landmarks[0], results.landmarks[1]);
    }

    // Use primary hand (first detected) for gestures
    const lm = results.landmarks[0];
    const gesture = detectGesture(lm);

    // Smooth the fingertip position
    const rawX = (1 - lm[8].x) * w;
    const rawY = lm[8].y * h;
    state.smoothX += (rawX - state.smoothX) * (1 - state.smoothing);
    state.smoothY += (rawY - state.smoothY) * (1 - state.smoothing);
    const sx = state.smoothX, sy = state.smoothY;

    // Convert cursor position to screen coordinates for the indicator
    const container = document.getElementById('canvas-container');
    const rect = container.getBoundingClientRect();
    const scaleX = rect.width / w;
    const scaleY = rect.height / h;
    updateCursor(sx * scaleX, sy * scaleY, gesture);

    updateGestureUI(gesture, numHands);

    // Gesture changed
    if (gesture !== state.lastGesture) {
        // Save undo when transitioning away from drawing/erasing
        if (state.lastGesture === 'DRAW' || state.lastGesture === 'ERASE') {
            saveUndo();
        }
        state.prevPoint = null;
        state.gestureStartTime = now;
        state.lastGesture = gesture;
    }

    // Process gesture actions
    switch (gesture) {
        case 'DRAW':
            if (state.tool === 'draw' || state.tool === 'text') {
                if (state.textPlacing) {
                    // Show floating text preview
                    fxCtx.save();
                    fxCtx.font = `bold 32px 'Outfit', sans-serif`;
                    fxCtx.fillStyle = state.color;
                    fxCtx.globalAlpha = 0.6;
                    fxCtx.textAlign = 'center';
                    fxCtx.textBaseline = 'middle';
                    fxCtx.fillText(state.pendingText || '', sx, sy);
                    fxCtx.restore();
                } else {
                    drawLine(sx, sy);
                }
            }
            break;
        case 'ERASE':
            eraseAt(sx, sy);
            break;
        case 'UNDO':
            if (!state.undoCooldown) {
                state.undoCooldown = true;
                performUndo();
                setTimeout(() => { state.undoCooldown = false; }, 800);
            }
            break;
        case 'PINCH':
            if (state.textPlacing) {
                placeText(sx, sy);
            }
            state.prevPoint = null;
            break;
        case 'FIST':
        case 'IDLE':
        default:
            state.prevPoint = null;
            break;
    }
}

// ===== Start =====
init().catch(err => {
    console.error('AirDraw init failed:', err);
    document.querySelector('.loader-text').textContent = 'Error: ' + err.message;
    document.querySelector('.loader-text').style.color = '#ff6b6b';
});
