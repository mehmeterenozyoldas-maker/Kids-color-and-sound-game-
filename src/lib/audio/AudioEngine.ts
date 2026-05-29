export class AudioEngine {
  private ctx: AudioContext;
  private masterGain: GainNode;

  // Drone
  private droneOsc: OscillatorNode;
  private droneGain: GainNode;
  private droneLfo: OscillatorNode;

  // Granular / Chime synth for interactions
  private interactGain: GainNode;

  private isInitialized = false;

  constructor() {
    this.ctx = new (
      window.AudioContext || (window as any).webkitAudioContext
    )();
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);
    this.masterGain.gain.value = 0.5;

    // Drone Synth Setup
    this.droneOsc = this.ctx.createOscillator();
    this.droneGain = this.ctx.createGain();
    this.droneLfo = this.ctx.createOscillator();

    this.droneOsc.type = "sine";
    this.droneOsc.frequency.value = 55; // Low A

    this.droneLfo.type = "sine";
    this.droneLfo.frequency.value = 0.1; // slow modulation

    // routing LFO -> Gain -> Output
    const targetGain = this.ctx.createGain();
    targetGain.gain.value = 0.2;
    this.droneLfo.connect(targetGain);
    targetGain.connect(this.droneGain.gain);

    this.droneOsc.connect(this.droneGain);
    this.droneGain.connect(this.masterGain);

    this.droneGain.gain.value = 0.1; // Base level

    // Interaction Synth
    this.interactGain = this.ctx.createGain();
    this.interactGain.connect(this.masterGain);
    this.interactGain.gain.value = 1.0;
  }

  public async init() {
    if (this.isInitialized) return;
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    this.droneOsc.start();
    this.droneLfo.start();
    this.isInitialized = true;
  }

  public setVolume(val: number) {
    this.masterGain.gain.setTargetAtTime(val, this.ctx.currentTime, 0.1);
  }

  public triggerChime(x: number, y: number, intensity: number) {
    if (!this.isInitialized) return;

    // Map X to pan (using stereo panner if available)
    let outputNode: AudioNode = this.interactGain;

    if (this.ctx.createStereoPanner) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = x * 2.0 - 1.0;
      panner.connect(this.interactGain);
      outputNode = panner;
    }

    // A beautiful A Minor Pentatonic chord scale spanning 4 octaves
    const midiScale = [
      48,
      50,
      52,
      55,
      57, // Octave 1: C3, D3, E3, G3, A3
      60,
      62,
      64,
      67,
      69, // Octave 2: C4, D4, E4, G4, A4
      72,
      74,
      76,
      79,
      81, // Octave 3: C5, D5, E5, G5, A5
      84,
      86,
      88,
      91,
      93, // Octave 4: C6, D6, E6, G6, A6 (warm sparkling highs)
    ];

    // Map X coordinate (0.0 to 1.0) directly to the notes index (lower pitch on left, higher on right)
    const scaleIndex = Math.min(
      Math.floor(x * midiScale.length),
      midiScale.length - 1,
    );
    const midiNote = midiScale[scaleIndex];
    const targetFreq = 440 * Math.pow(2, (midiNote - 69) / 12);

    const now = this.ctx.currentTime;
    const notesToStop: { osc: OscillatorNode; env: GainNode }[] = [];

    // Synthesize premium acoustic piano using additive harmonics
    // Strong fundamental, moderate lower overtones, fast-decaying high overtones
    const harmonics = [
      { ratio: 1.0, amp: 0.4, decay: 2.2 }, // Fundamental string body
      { ratio: 2.0, amp: 0.2, decay: 1.4 }, // First octave
      { ratio: 3.0, amp: 0.1, decay: 0.8 }, // Fifth harmonic (warm color)
      { ratio: 4.0, amp: 0.05, decay: 0.5 }, // Second octave (brightness)
      { ratio: 5.0, amp: 0.02, decay: 0.3 }, // Third harmonic (rich tension)
    ];

    harmonics.forEach(({ ratio, amp, decay }) => {
      const osc = this.ctx.createOscillator();
      const env = this.ctx.createGain();

      osc.type = "sine";
      osc.frequency.value = targetFreq * ratio;

      // Gentle detuning on overtones to add chorus string simulation
      if (ratio > 1.0) {
        osc.detune.value = (Math.random() - 0.5) * 8;
      }

      osc.connect(env);
      env.connect(outputNode);

      env.gain.setValueAtTime(0, now);
      // Fast acoustic transient attack
      env.gain.linearRampToValueAtTime(amp * intensity * 0.45, now + 0.005);
      // Realistic exponential piano key decay
      env.gain.exponentialRampToValueAtTime(0.0001, now + decay);

      osc.start(now);
      osc.stop(now + decay + 0.1);

      notesToStop.push({ osc, env });
    });

    // Hammer strike acoustic attack: quick wooden "ping" transient
    const transientOsc = this.ctx.createOscillator();
    const transientEnv = this.ctx.createGain();

    transientOsc.type = "triangle";
    transientOsc.frequency.value = targetFreq * 8.0;
    transientOsc.detune.value = (Math.random() - 0.5) * 30; // warm noise transient

    transientOsc.connect(transientEnv);
    transientEnv.connect(outputNode);

    transientEnv.gain.setValueAtTime(0, now);
    transientEnv.gain.linearRampToValueAtTime(0.12 * intensity, now + 0.002);
    transientEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);

    transientOsc.start(now);
    transientOsc.stop(now + 0.05);

    // Garbage collection of active nodes
    setTimeout(() => {
      notesToStop.forEach(({ osc, env }) => {
        try {
          osc.disconnect();
          env.disconnect();
        } catch (e) {}
      });
      try {
        transientOsc.disconnect();
        transientEnv.disconnect();
      } catch (e) {}
    }, 4000);
  }

  public updateDroneField(avgFieldEnergy: number) {
    if (!this.isInitialized) return;
    // Modulate the drone base gain based on global field energy
    const targetEnergy = Math.min(avgFieldEnergy, 1.0) * 0.4 + 0.1;
    this.droneGain.gain.setTargetAtTime(
      targetEnergy,
      this.ctx.currentTime,
      2.0,
    );
  }

  public dispose() {
    this.droneOsc.stop();
    this.droneLfo.stop();
    this.ctx.close();
  }
}
