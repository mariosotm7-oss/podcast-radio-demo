// script.js
// Estación de podcast completa — grabación, fondo, mezcla y exportación WAV.
// NOTAS: Todo corre en cliente. Usa API WebAudio + MediaRecorder.

(() => {
  // DOM
  const statusEl = document.getElementById('status');
  const bgFileInput = document.getElementById('bg-file');
  const bgPlayBtn = document.getElementById('bg-play');
  const bgStopBtn = document.getElementById('bg-stop');
  const bgVolume = document.getElementById('bg-volume');
  const bgVolLabel = document.getElementById('bg-vol-label');
  const bgLoop = document.getElementById('bg-loop');

  const micList = document.getElementById('mic-list');
  const btnRecord = document.getElementById('btn-record');
  const btnStop = document.getElementById('btn-stop');
  const micVolume = document.getElementById('mic-volume');
  const micVolLabel = document.getElementById('mic-vol-label');
  const monitorCheckbox = document.getElementById('monitor');

  const preview = document.getElementById('preview');
  const btnDownloadVoice = document.getElementById('btn-download-voice');
  const btnDownloadMix = document.getElementById('btn-download-mix');
  const recTimeEl = document.getElementById('rec-time');

  // Audio context and nodes
  let audioCtx;
  let bgBuffer = null;        // AudioBuffer for background
  let bgSource = null;        // current bg AudioBufferSourceNode
  let bgGainNode = null;
  let micGainNode = null;
  let destNode = null;

  // Recording
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordingStart = null;
  let recTimer = null;
  let recordedBlob = null; // recorded voice blob (webm/ogg)
  let recordedBuffer = null; // decoded AudioBuffer of voice for mixing

  // Init
  function setStatus(txt) { statusEl.textContent = txt; }
  function formatTime(secs) {
    const s = Math.floor(secs % 60).toString().padStart(2,'0');
    const m = Math.floor(secs / 60).toString().padStart(2,'0');
    return `${m}:${s}`;
  }

  // Ensure we have audio context when needed
  function ensureAudioContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
  }

  // List available input devices (mic)
  async function enumerateMics() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');
      micList.innerHTML = '';
      inputs.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Micrófono ${micList.length + 1}`;
        micList.appendChild(opt);
      });
      if (inputs.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = 'No se encontró micrófono';
        micList.appendChild(opt);
      }
    } catch (err) {
      console.warn('enumerateDevices error', err);
    }
  }

  // Load background from file input
  bgFileInput.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    setStatus('Cargando fondo...');
    ensureAudioContext();
    const array = await f.arrayBuffer();
    try {
      bgBuffer = await audioCtx.decodeAudioData(array.slice(0));
      setStatus('Fondo listo');
      bgPlayBtn.disabled = false;
      bgStopBtn.disabled = true;
      // auto-start playback?
    } catch (err) {
      console.error(err);
      setStatus('Error al cargar el audio de fondo');
    }
  });

  // Play background
  function startBg() {
    if (!bgBuffer) return;
    stopBg(); // ensure single source
    ensureAudioContext();

    bgSource = audioCtx.createBufferSource();
    bgSource.buffer = bgBuffer;
    bgSource.loop = bgLoop.checked;

    bgGainNode = audioCtx.createGain();
    bgGainNode.gain.value = parseFloat(bgVolume.value || 0.4);

    bgSource.connect(bgGainNode).connect(audioCtx.destination);
    bgSource.start(0);
    bgPlayBtn.disabled = true;
    bgStopBtn.disabled = false;
    setStatus('Reproduciendo fondo');
  }

  function stopBg() {
    if (bgSource) {
      try { bgSource.stop(); } catch(e){}
      try { bgSource.disconnect(); } catch(e){}
      bgSource = null;
    }
    bgPlayBtn.disabled = !(bgBuffer);
    bgStopBtn.disabled = true;
    setStatus('Fondo detenido');
  }

  bgPlayBtn.addEventListener('click', startBg);
  bgStopBtn.addEventListener('click', stopBg);

  bgVolume.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    bgVolLabel.textContent = `${Math.round(v * 100)}%`;
    if (bgGainNode) bgGainNode.gain.value = v;
  });

  bgLoop.addEventListener('change', () => {
    if (bgSource) bgSource.loop = bgLoop.checked;
  });

  // Request mic and prepare stream
  async function getMicStream(deviceId) {
    const constraints = {
      audio: deviceId ? { deviceId } : true,
      video: false
    };
    return await navigator.mediaDevices.getUserMedia(constraints);
  }

  // Start recording
  btnRecord.addEventListener('click', async () => {
    try {
      setStatus('Solicitando micrófono...');
      btnRecord.disabled = true;
      ensureAudioContext();

      const deviceId = micList.value || null;
      const micStream = await getMicStream(deviceId);

      // create nodes for live monitoring and also route to MediaStream for recording
      const sourceNode = audioCtx.createMediaStreamSource(micStream);

      // Gains
      micGainNode = audioCtx.createGain();
      micGainNode.gain.value = parseFloat(micVolume.value || 1);

      // destination for playback (monitor)
      const destination = audioCtx.destination;

      // Create a mixed output stream for recording using a MediaStreamDestination
      destNode = audioCtx.createMediaStreamDestination();

      // Connect source -> micGain -> (if monitor) destination -> always to destNode
      sourceNode.connect(micGainNode);
      micGainNode.connect(destNode); // go to the recording destination
      if (monitorCheckbox.checked) {
        micGainNode.connect(destination);
      }

      // Also connect background into destNode so the background is included in the raw recording?
      // Important: we DO NOT automatically record background into MediaRecorder,
      // we prefer: record only mic, then mix offline to have maximum control.
      // So we will not connect bgGain to destNode for MediaRecorder. Recording will capture only mic.

      // Initialize MediaRecorder on the micStream directly (better compatibility)
      // We will record the micStream produced by getUserMedia (not destNode.stream) to get raw mic.
      // But to ensure we're using the same source, record the original micStream.
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(micStream, { mimeType: 'audio/webm' });
      mediaRecorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size) recordedChunks.push(ev.data);
      };
      mediaRecorder.onstop = handleRecordingStop;
      mediaRecorder.start(100); // timeslice for dataavailable

      // Start background playback if loaded and desired
      if (bgBuffer && !bgSource) {
        // Create separate bgSource for live monitoring
        bgSource = audioCtx.createBufferSource();
        bgSource.buffer = bgBuffer;
        bgSource.loop = bgLoop.checked;
        bgGainNode = audioCtx.createGain();
        bgGainNode.gain.value = parseFloat(bgVolume.value || 0.4);
        bgSource.connect(bgGainNode).connect(audioCtx.destination);
        bgSource.start(0);
      }

      // UI
      btnStop.disabled = false;
      setStatus('Grabando...');
      recordingStart = Date.now();
      recTimer = setInterval(() => {
        const elapsed = (Date.now() - recordingStart) / 1000;
        recTimeEl.textContent = formatTime(elapsed);
      }, 300);

    } catch (err) {
      console.error(err);
      setStatus('Error accediendo al micrófono');
      btnRecord.disabled = false;
    }
  });

  // Stop recording
  btnStop.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
    // stop background monitoring while recording ended
    stopBg();
    btnStop.disabled = true;
    btnRecord.disabled = false;
    clearInterval(recTimer);
    recTimer = null;
  });

  // When MediaRecorder stops -> process recorded chunks
  async function handleRecordingStop() {
    recordedBlob = new Blob(recordedChunks, { type: recordedChunks[0]?.type || 'audio/webm' });
    setStatus('Grabación lista');
    // create preview of raw mic
    const url = URL.createObjectURL(recordedBlob);
    preview.src = url;
    preview.controls = true;
    preview.play().catch(()=>{});
    btnDownloadVoice.disabled = false;
    btnDownloadMix.disabled = false;

    // decode recorded blob to AudioBuffer for mixing
    ensureAudioContext();
    const array = await recordedBlob.arrayBuffer();
    try {
      recordedBuffer = await audioCtx.decodeAudioData(array.slice(0));
    } catch (err) {
      // Some browsers produce codecs not decodable by AudioContext (rare).
      console.warn('decode error', err);
      recordedBuffer = null;
    }
  }

  // Download only voice (raw recording) as WAV
  btnDownloadVoice.addEventListener('click', async () => {
    if (!recordedBlob) return;
    setStatus('Preparando WAV de voz...');
    // Convert recordedBlob (likely webm/ogg) to WAV client-side: decode to AudioBuffer -> encode WAV
    ensureAudioContext();
    try {
      const array = await recordedBlob.arrayBuffer();
      const buffer = await audioCtx.decodeAudioData(array.slice(0));
      const wav = encodeWAV(buffer);
      downloadBlob(wav, `voz_${timestamp()}.wav`);
      setStatus('Voz descargada');
    } catch (err) {
      console.error(err);
      setStatus('Error al crear WAV de voz');
    }
  });

  // Mix voice + background into final WAV
  btnDownloadMix.addEventListener('click', async () => {
    if (!recordedBlob) return;
    setStatus('Generando mezcla (voz + fondo)...');
    ensureAudioContext();

    try {
      // decode voice if not already decoded
      let voiceBuffer = recordedBuffer;
      if (!voiceBuffer) {
        const arr = await recordedBlob.arrayBuffer();
        voiceBuffer = await audioCtx.decodeAudioData(arr.slice(0));
      }
      // If no background chosen -> just export voice
      if (!bgBuffer) {
        const wav = encodeWAV(voiceBuffer);
        downloadBlob(wav, `mezcla_${timestamp()}.wav`);
        setStatus('Descargado (solo voz)');
        return;
      }

      // OfflineAudioContext to render mix (sampleRate consistent with audioCtx)
      const sampleRate = audioCtx.sampleRate;
      // Determine length: max(voice length, bg length) or voice length
      const length = Math.max(voiceBuffer.length, bgBuffer.length);
      const offlineCtx = new OfflineAudioContext(2, Math.ceil(voiceBuffer.duration * sampleRate), sampleRate);

      // Create buffer source for voice
      const voiceSource = offlineCtx.createBufferSource();
      voiceSource.buffer = voiceBuffer;

      // Create gain for voice using micVolume control (we used micVolume during recording; allow exporting same)
      const voiceGain = offlineCtx.createGain();
      voiceGain.gain.value = parseFloat(micVolume.value || 1);

      // Create bg source and bg gain
      const bgSourceOffline = offlineCtx.createBufferSource();
      bgSourceOffline.buffer = bgBuffer;
      bgSourceOffline.loop = bgLoop.checked;
      const bgGainOffline = offlineCtx.createGain();
      bgGainOffline.gain.value = parseFloat(bgVolume.value || 0.4);

      // Connect nodes: voice -> gain -> dest ; bg -> gain -> dest
      voiceSource.connect(voiceGain).connect(offlineCtx.destination);
      bgSourceOffline.connect(bgGainOffline).connect(offlineCtx.destination);

      // Start at 0
      voiceSource.start(0);
      bgSourceOffline.start(0);

      // Render the mixed audio
      const rendered = await offlineCtx.startRendering();

      // Encode rendered (AudioBuffer) to WAV
      const wav = encodeWAV(rendered);
      downloadBlob(wav, `mezcla_${timestamp()}.wav`);
      setStatus('Mezcla descargada');
    } catch (err) {
      console.error(err);
      setStatus('Error creando mezcla');
    }
  });

  // Helpers
  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 2000);
  }
  function timestamp() {
    const d = new Date();
    return `${d.getFullYear()}${(d.getMonth()+1).toString().padStart(2,'0')}${d.getDate().toString().padStart(2,'0')}_${d.getHours().toString().padStart(2,'0')}${d.getMinutes().toString().padStart(2,'0')}${d.getSeconds().toString().padStart(2,'0')}`;
  }

  // WAV encoder (16-bit PCM) from AudioBuffer
  // returns a Blob with 'audio/wav'
  function encodeWAV(audioBuffer) {
    const numChannels = Math.min(2, audioBuffer.numberOfChannels);
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length * numChannels * 2; // 16-bit
    const buffer = new ArrayBuffer(44 + audioBuffer.length * numChannels * 2);
    const view = new DataView(buffer);

    // RIFF identifier 'RIFF'
    writeString(view, 0, 'RIFF');
    // RIFF chunk length
    view.setUint32(4, 36 + audioBuffer.length * numChannels * 2, true);
    // RIFF type 'WAVE'
    writeString(view, 8, 'WAVE');
    // format chunk 'fmt '
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * 2, true); // byte rate
    view.setUint16(32, numChannels * 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample

    // data chunk
    writeString(view, 36, 'data');
    view.setUint32(40, audioBuffer.length * numChannels * 2, true);

    // write interleaved PCM samples
    let offset = 44;
    const channelData = [];
    for (let ch = 0; ch < numChannels; ch++) {
      channelData.push(audioBuffer.getChannelData(ch));
    }
    for (let i = 0; i < audioBuffer.length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = Math.max(-1, Math.min(1, channelData[ch][i]));
        // convert to 16-bit PCM
        sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset, sample, true);
        offset += 2;
      }
    }
    return new Blob([view], { type: 'audio/wav' });

    function writeString(view, offset, str) {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    }
  }

  // UI updates for mic volume and monitor
  micVolume.addEventListener('input', () => {
    micVolLabel.textContent = `${Math.round(parseFloat(micVolume.value) * 100)}%`;
    if (micGainNode) micGainNode.gain.value = parseFloat(micVolume.value);
  });

  monitorCheckbox.addEventListener('change', () => {
    // If monitoring toggled while recording, connect/disconnect live monitoring
    if (audioCtx && micGainNode) {
      if (monitorCheckbox.checked) {
        micGainNode.connect(audioCtx.destination);
      } else {
        try { micGainNode.disconnect(audioCtx.destination); } catch(e){}
      }
    }
  });

  // Populate devices on load and when permission changes
  async function init() {
    setStatus('Inicializando...');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('API de audio no disponible en este navegador.');
      btnRecord.disabled = true;
      return;
    }
    await enumerateMics();
    // Try to get permission silently to reveal device labels (optional)
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      await enumerateMics();
    } catch (err) {
      // permission denied or not yet granted
      console.warn('sin permisos iniciales', err);
    }
    setStatus('Listo para grabar');
  }

  // Start
  init();

  // Expose a basic cleanup before unload
  window.addEventListener('beforeunload', () => {
    if (bgSource) {
      try { bgSource.stop(); } catch (e) {}
    }
    if (audioCtx && audioCtx.state !== 'closed') audioCtx.close();
  });

})();