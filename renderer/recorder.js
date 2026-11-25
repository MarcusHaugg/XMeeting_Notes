// Captura de áudio: microfone ("Você") e áudio do sistema ("Outros") em trilhas separadas.
// O áudio do sistema vem do loopback do Windows, liberado pelo processo principal sem diálogo.
(() => {
  const MIME = 'audio/webm;codecs=opus';

  async function startCapture() {
    let mic = null;
    let micError = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (err) {
      micError = err;
    }

    let display = null;
    let systemTrack = null;
    let systemError = null;
    try {
      // O vídeo precisa continuar vivo para o Windows seguir entregando o áudio do sistema,
      // então pedimos o mínimo possível (1 quadro/s, baixa resolução) e nunca o usamos.
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { max: 1 }, width: { max: 320 }, height: { max: 240 } },
        audio: true,
      });
      systemTrack = display.getAudioTracks()[0] ?? null;
      if (!systemTrack) systemError = 'a captura não trouxe trilha de áudio';
    } catch (err) {
      systemError = `${err.name}: ${err.message}`;
      console.warn('Áudio do sistema indisponível:', err);
    }

    // Linux: se o loopback não veio, usa o "Monitor" do PulseAudio/PipeWire (o som que sai do PC).
    if (!systemTrack && window.api?.platform === 'linux') {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const monitor = devices.find((d) => d.kind === 'audioinput' && /monitor/i.test(d.label));
        if (monitor) {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: monitor.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          });
          systemTrack = stream.getAudioTracks()[0] ?? null;
          if (systemTrack) systemError = null;
        }
      } catch (err) {
        console.warn('Monitor de áudio indisponível:', err);
      }
    }

    if (!mic && !systemTrack) {
      throw new Error(
        micError?.name === 'NotAllowedError'
          ? 'O microfone está bloqueado. No Windows, abra Configurações > Privacidade e segurança > Microfone e ative "Permitir que aplicativos da área de trabalho acessem o microfone".'
          : 'Não consegui acessar nem o microfone nem o áudio do sistema.'
      );
    }

    // Passar as trilhas pelo mesmo AudioContext mantém as duas no mesmo relógio,
    // inclusive nos silêncios, então "Você" e "Outros" ficam alinhados no tempo.
    const ctx = new AudioContext();
    await ctx.resume();

    const sources = [];
    if (mic) sources.push({ name: 'mic', track: mic.getAudioTracks()[0] });
    if (systemTrack) sources.push({ name: 'system', track: systemTrack });

    const tracks = sources.map(({ name, track }) => {
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      const dest = ctx.createMediaStreamDestination();
      dest.channelCount = 1;
      dest.channelCountMode = 'explicit';
      source.connect(analyser);
      source.connect(dest);
      return { name, analyser, dest, recorder: null, chain: Promise.resolve(), samples: new Float32Array(analyser.fftSize) };
    });

    return {
      hasMic: Boolean(mic),
      hasSystemAudio: Boolean(systemTrack),
      micError: micError ? `${micError.name}: ${micError.message}` : null,
      systemError,
      trackNames: tracks.map((t) => t.name),

      // Diagnóstico: grava a trilha do sistema "crua" (sem passar pelo AudioContext) e conta os bytes.
      startRawSystemProbe() {
        if (!systemTrack) return null;
        const rec = new MediaRecorder(new MediaStream([systemTrack]), { mimeType: MIME });
        let bytes = 0;
        rec.ondataavailable = (e) => (bytes += e.data.size);
        rec.start(1000);
        return () =>
          new Promise((resolve) => {
            rec.onstop = () => resolve(bytes);
            rec.stop();
          });
      },

      systemDiagnostics() {
        if (!systemTrack) return null;
        const { sampleRate, channelCount, deviceId } = systemTrack.getSettings();
        return { muted: systemTrack.muted, readyState: systemTrack.readyState, sampleRate, channelCount, deviceId };
      },

      onSystemEnded(callback) {
        systemTrack?.addEventListener('ended', callback);
      },

      start(sendChunk) {
        for (const t of tracks) {
          t.recorder = new MediaRecorder(t.dest.stream, { mimeType: MIME, audioBitsPerSecond: 48000 });
          t.recorder.ondataavailable = (e) => {
            if (!e.data.size) return;
            // Encadeado para os pedaços chegarem ao disco na ordem certa.
            t.chain = t.chain.then(async () => sendChunk(t.name, new Uint8Array(await e.data.arrayBuffer())));
          };
          t.recorder.start(1000); // um pedaço por segundo
        }
      },

      levels() {
        const out = {};
        for (const t of tracks) {
          t.analyser.getFloatTimeDomainData(t.samples);
          let sum = 0;
          for (const v of t.samples) sum += v * v;
          out[t.name] = Math.sqrt(sum / t.samples.length);
        }
        return out;
      },

      async stop() {
        await Promise.all(
          tracks.map((t) =>
            t.recorder && t.recorder.state !== 'inactive'
              ? new Promise((resolve) => {
                  t.recorder.addEventListener('stop', resolve, { once: true });
                  t.recorder.stop();
                })
              : null
          )
        );
        await Promise.all(tracks.map((t) => t.chain));
        mic?.getTracks().forEach((t) => t.stop());
        display?.getTracks().forEach((t) => t.stop());
        systemTrack?.stop();
        await ctx.close();
      },
    };
  }

  window.MNRecorder = { startCapture };
})();
