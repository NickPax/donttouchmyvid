/// <reference lib="webworker" />
//
// Video compression worker.
// Pipeline: mp4box (demux) → WebCodecs VideoDecoder → VideoEncoder → mp4-muxer (mux).
// Audio is passed through (re-muxed without re-encoding) when the input is AAC.
//
// We run in a Worker so a 2GB file doesn't lock the UI thread, and so that the
// Muxer's in-memory buffer is GC'd cleanly when the worker finishes.
//
// Caveats for V1:
//   - Input must be MP4/MOV with H.264 (avc1) or HEVC (hvc1) video.
//   - Audio is passed through only if AAC. Other audio is dropped.
//   - We DO buffer the whole input file inside mp4box during demux. Streaming
//     demux that releases parsed samples is a future optimisation; the current
//     approach already keeps a 2GB file workable on a modern desktop because
//     the worker heap is independent of the page.

import MP4Box from 'mp4box';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

type Preset = 'tiny' | 'small' | 'high';

type InMsg =
  | { type: 'start'; file: File; preset: Preset }
  | { type: 'cancel' };

type OutMsg =
  | { type: 'status'; label: string; pct?: number }
  | { type: 'progress'; stage: 'read' | 'encode' | 'finalise'; read?: number; total?: number; encoded?: number; totalSamples?: number; sizeEstimate?: number }
  | { type: 'meta'; durationSec: number; widthIn: number; heightIn: number; widthOut: number; heightOut: number; fps: number; hasAudio: boolean; codecIn: string; codecOut: string }
  | { type: 'phase'; name: string; detail?: string }
  | { type: 'heartbeat'; samplesIn: number; framesDecoded: number; chunksEncoded: number; decoderQueue: number; encoderQueue: number; decoderState: string; encoderState: string }
  | { type: 'done'; blob: Blob; size: number; durationMs: number }
  | { type: 'error'; message: string };

const presetBitrates: Record<Preset, number> = {
  tiny:  1_500_000,  // ~1.5 Mbps  — heavy compression
  small: 4_000_000,  // ~4 Mbps    — recommended default
  high:  7_500_000,  // ~7.5 Mbps  — high quality
};

let cancelled = false;

const post = (msg: OutMsg) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
const phase = (name: string, detail?: string) => post({ type: 'phase', name, detail });

// Catch anything that escapes the orchestrator — silent worker hangs are the
// worst kind of bug, so make any uncaught error / rejection visible to the UI.
self.addEventListener('error', (e) => {
  post({ type: 'error', message: `Worker crashed: ${e.message || 'unknown error'}` });
});
self.addEventListener('unhandledrejection', (e: any) => {
  const reason = e?.reason;
  const msg = reason instanceof Error ? reason.message : String(reason ?? 'unknown rejection');
  post({ type: 'error', message: `Worker rejection: ${msg}` });
});

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (msg.type === 'start') {
    cancelled = false;
    const t0 = performance.now();
    try {
      await runCompression(msg.file, msg.preset);
      post({ type: 'done', blob: lastBlob!, size: lastBlob!.size, durationMs: performance.now() - t0 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!cancelled) post({ type: 'error', message });
    }
  }
};

let lastBlob: Blob | null = null;

// Counters live at module scope so the heartbeat / stall watcher can read them.
let samplesIn = 0;
let framesDecoded = 0;
let chunksEncoded = 0;

async function runCompression(file: File, preset: Preset) {
  samplesIn = 0;
  framesDecoded = 0;
  chunksEncoded = 0;
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
    throw new Error("Your browser doesn't support WebCodecs. Try the latest Chrome, Edge or Firefox.");
  }

  post({ type: 'status', label: 'Reading file', pct: 1 });
  phase('start', `${file.name} · ${file.size} bytes`);

  // Pipeline error is shared across the feed loop, decoder/encoder error
  // callbacks, and the orchestrator. Declare up-front so closures see it.
  let pipelineErr: Error | null = null;
  let lastDecodedSample = -1;

  // -------- Demuxer --------
  const inputFile: any = (MP4Box as any).createFile();
  let infoResolve!: (info: any) => void;
  let infoReject!: (err: Error) => void;
  const infoPromise = new Promise<any>((res, rej) => { infoResolve = res; infoReject = rej; });

  inputFile.onReady = (info: any) => { phase('mp4box.onReady', `${info.videoTracks?.length ?? 0} video / ${info.audioTracks?.length ?? 0} audio tracks`); infoResolve(info); };
  inputFile.onError = (msg: string) => infoReject(new Error(`We couldn't read this file's structure (${msg}). Either it's not actually an MP4 / MOV, or it was written in a way our demuxer doesn't recognise. Re-saving through QuickTime usually tidies it up.`));

  // Stream-feed the file from disk to mp4box. We don't backpressure here
  // anymore — onSamples just stashes constructed chunks into videoChunkQueue
  // (cheap), and a separate async pump (defined further down) is what actually
  // talks to the decoder, with proper queue-depth throttling. That decoupling
  // is the load-bearing fix for moov-at-end files where mp4box.start() emits
  // every sample synchronously after the file is fully fed.
  const reader = file.stream().getReader();
  let offset = 0;
  const feedDone = (async () => {
    while (true) {
      if (cancelled) throw new Error('Cancelled');
      const { value, done } = await reader.read();
      if (done) break;
      const view = value as Uint8Array;
      const ab = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer & { fileStart?: number };
      ab.fileStart = offset;
      offset += view.byteLength;
      inputFile.appendBuffer(ab);
      post({ type: 'progress', stage: 'read', read: offset, total: file.size });
    }
    inputFile.flush();
    phase('feed.complete', `${offset} bytes fed to mp4box`);
  })();

  // Whichever fires first: onReady (preferred) or feed completion (fallback / failure).
  // Add a 5-second grace after the file is fully fed: if mp4box hasn't seen
  // a moov atom by then, the file structure is broken in a way mp4box can't
  // decode and we should fail fast instead of hanging forever.
  const info = await Promise.race([
    infoPromise,
    (async () => {
      await feedDone;
      await new Promise((r) => setTimeout(r, 5000));
      // Race: if infoPromise has already settled this resolves silently with it.
      // If not, we throw a useful message rather than hang.
      return Promise.race([
        infoPromise,
        new Promise((_, rej) => rej(new Error(
          "We read the whole file but couldn't find a usable MP4 / MOV structure inside it. " +
          "This usually means the file isn't really an MP4, or it's a fragmented format we don't yet support. " +
          "If it came from a screen recorder or older camera, try opening in QuickTime and File → Save As (or use Handbrake) to rewrite it as a standard MP4."
        ))),
      ]);
    })(),
  ]);
  phase('demux.ready');

  if (!info.videoTracks?.length) {
    throw new Error("There's no video track in this file. We're a video compressor — you've handed us audio. The Extract Audio tool is on the way; for now, you'll want a different tool.");
  }

  const videoTrack = info.videoTracks[0];
  const audioTrack = info.audioTracks?.[0];
  const videoTrak = inputFile.getTrackById(videoTrack.id);

  const videoDesc = extractCodecBox(videoTrak);
  if (!videoDesc) {
    throw new Error(`We can only handle H.264 (avc1) or HEVC (hvc1) source video right now — yours is '${videoTrack.codec}'. AV1, VP9 and friends are on the list; meanwhile a quick QuickTime / Handbrake re-export to H.264 will get you through this tool today.`);
  }

  let audioDesc: Uint8Array | undefined;
  let audioOk = false;
  if (audioTrack) {
    const audioTrak = inputFile.getTrackById(audioTrack.id);
    audioDesc = extractAacConfig(audioTrak);
    audioOk = !!audioDesc && audioTrack.codec.startsWith('mp4a');
  }

  const inW = videoTrack.video.width;
  const inH = videoTrack.video.height;
  const fps = videoTrack.nb_samples && videoTrack.duration
    ? Math.max(1, Math.round((videoTrack.nb_samples * videoTrack.timescale) / videoTrack.duration))
    : 30;

  // Output dims: keep aspect, cap at 1920 on long edge.
  const maxDim = 1920;
  let outW = inW;
  let outH = inH;
  if (Math.max(inW, inH) > maxDim) {
    const s = maxDim / Math.max(inW, inH);
    outW = Math.max(2, Math.round((inW * s) / 2) * 2);
    outH = Math.max(2, Math.round((inH * s) / 2) * 2);
  }

  const durationSec = videoTrack.duration / videoTrack.timescale;

  post({
    type: 'meta',
    durationSec,
    widthIn: inW, heightIn: inH,
    widthOut: outW, heightOut: outH,
    fps, hasAudio: audioOk,
    codecIn: videoTrack.codec,
    codecOut: 'avc1',
  });

  // -------- Pre-flight: verify the browser actually supports this combo --------
  // Doing this BEFORE configuring gives a much better error than the bare
  // "Decoding error." that VideoDecoder.error throws when it chokes mid-stream.
  const decoderConfig: VideoDecoderConfig = {
    codec: videoTrack.codec,
    codedWidth: inW,
    codedHeight: inH,
    description: videoDesc,
    hardwareAcceleration: 'prefer-hardware',
  };
  const decSupport = await VideoDecoder.isConfigSupported(decoderConfig).catch(() => null);
  if (!decSupport?.supported) {
    const isHEVC = videoTrack.codec.startsWith('hvc1') || videoTrack.codec.startsWith('hev1');
    throw new Error(
      isHEVC
        ? `Your browser shrugs at HEVC (${videoTrack.codec}). Codec support comes from the browser, not from us — desktop Safari knows it, most Chrome builds don't. Quickest unstuck: open the file in QuickTime, File → Export As → 1080p (gives you plain H.264), then drop the export back here.`
        : `Your browser doesn't know this codec (${videoTrack.codec}). Codec support comes from the browser, not from us. Chrome / Edge are usually the safest bet — failing that, re-export the file as plain H.264 in QuickTime / Handbrake and try again.`
    );
  }

  // Build the encoder config and verify it too.
  // Use Baseline profile @ 5.1 for maximum compatibility — it accepts up to
  // 4K and is what every device on earth can play back.
  const encoderConfig: VideoEncoderConfig = {
    codec: 'avc1.42E033',
    width: outW,
    height: outH,
    bitrate: presetBitrates[preset],
    framerate: fps,
    avc: { format: 'avc' },
    bitrateMode: 'variable',
    hardwareAcceleration: 'prefer-hardware',
    // Latency mode 'realtime' lets the encoder emit chunks more eagerly
    // (don't wait to optimise B-frame ordering) — better for streaming
    // re-encode where we're already throttled by upstream backpressure.
    latencyMode: 'realtime',
  };
  const encSupport = await VideoEncoder.isConfigSupported(encoderConfig).catch(() => null);
  if (!encSupport?.supported) {
    throw new Error(`Your browser refuses to encode H.264 at ${outW}×${outH}. (Hand on heart: that one's unusual.) Chrome / Edge will almost certainly do it.`);
  }

  // -------- Muxer --------
  // firstTimestampBehavior:'offset' is load-bearing. By default mp4-muxer
  // rejects a track whose first chunk DTS is non-zero — which is common in
  // real-world MP4s (edition lists, composition offsets, B-frame ordering).
  // 'offset' tells the muxer to subtract the first timestamp from all
  // subsequent ones so the track starts at exactly 0 in the output.
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
    video: {
      codec: 'avc',
      width: outW,
      height: outH,
      frameRate: fps,
    },
    audio: audioOk ? {
      codec: 'aac',
      numberOfChannels: audioTrack.audio.channel_count,
      sampleRate: audioTrack.audio.sample_rate,
    } : undefined,
  });

  // -------- Capture pipeline errors so we can re-throw with context --------
  // VideoDecoder/Encoder fire `error` callbacks asynchronously. If we just
  // re-throw inside the callback, the error becomes an unhandled rejection
  // and the worker reports the bare DOMException ("Decoding error.") with no
  // useful context. Stash it instead and throw from the orchestrator with
  // the codec / sample number attached.
  const failPipeline = (e: unknown, where: string) => {
    if (pipelineErr) return;
    const raw = e instanceof Error ? e.message : String(e);
    // The browser's WebCodecs error messages are famously curt — "Decoding error."
    // is the whole thing. Wrap with a bit of voice + the bits a person actually
    // needs to know what to try next.
    const lead =
      where === 'Decode' ? "Your browser tapped out while decoding"
      : where === 'Encode' ? "The encoder lost its nerve"
      : "The muxer tripped over itself";
    const sampleHint = lastDecodedSample >= 0 ? ` around sample ${lastDecodedSample + 1}` : '';
    pipelineErr = new Error(
      `${lead}${sampleHint}. Browser said: "${raw}". ` +
      `Codec ${videoTrack.codec}, ${inW}×${inH}. ` +
      `If the file came from a screen recorder, an old phone, or anything HEVC-flavoured, the cure is usually: re-export as plain H.264 (QuickTime → Export As, or Handbrake) and drop that back here.`
    );
  };

  // -------- Video encoder --------
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        muxer.addVideoChunk(chunk, meta);
        chunksEncoded++;
        if (chunksEncoded === 1) phase('encoder.first-chunk');
        if (chunksEncoded % 10 === 0 || chunk.type === 'key') {
          post({ type: 'progress', stage: 'encode', encoded: chunksEncoded, totalSamples: videoTrack.nb_samples });
        }
      } catch (e) { failPipeline(e, 'Mux'); }
    },
    error: (e) => failPipeline(e, 'Encode'),
  });
  encoder.configure(encoderConfig);
  phase('encoder.configured');

  // -------- Video decoder --------
  const willScale = outW !== inW || outH !== inH;
  let scaler: OffscreenCanvas | null = null;
  let scalerCtx: OffscreenCanvasRenderingContext2D | null = null;
  if (willScale) {
    scaler = new OffscreenCanvas(outW, outH);
    scalerCtx = scaler.getContext('2d');
  }

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        if (cancelled || pipelineErr) { frame.close(); return; }
        if (framesDecoded === 0) phase('decoder.first-frame');
        const keyFrame = framesDecoded % Math.max(1, fps * 2) === 0;
        if (willScale && scalerCtx) {
          scalerCtx.drawImage(frame, 0, 0, outW, outH);
          const scaled = new VideoFrame(scaler!, { timestamp: frame.timestamp, duration: frame.duration ?? undefined });
          frame.close();
          encoder.encode(scaled, { keyFrame });
          scaled.close();
        } else {
          encoder.encode(frame, { keyFrame });
          frame.close();
        }
        framesDecoded++;
      } catch (err) {
        try { frame.close(); } catch {}
        failPipeline(err, 'Encode');
      }
    },
    error: (e) => failPipeline(e, 'Decode'),
  });

  decoder.configure(decoderConfig);
  phase('decoder.configured');

  // -------- Sample extraction --------
  inputFile.setExtractionOptions(videoTrack.id, 'video', { nbSamples: 30 });
  if (audioOk) inputFile.setExtractionOptions(audioTrack.id, 'audio', { nbSamples: 100 });

  // Video chunks are queued here, then drained by an async pump that respects
  // the decoder + encoder queue depths. This is the load-bearing fix for
  // moov-at-end files: mp4box.start() emits ALL samples synchronously in one
  // burst (because they were all parsed already during the file feed), so we
  // can't backpressure inside onSamples — the only sane option is to stash
  // the constructed chunks and feed them to the decoder at a sustainable rate.
  const videoChunkQueue: { chunk: EncodedVideoChunk; sampleNumber: number }[] = [];
  let allVideoSamplesEmitted = false;

  let audioMetaSent = false;
  inputFile.onSamples = (_id: number, user: string, samples: any[]) => {
    if (cancelled || pipelineErr) return;
    if (user === 'video') {
      if (samplesIn === 0) phase('mp4box.first-samples', `${samples.length} samples`);
      for (const s of samples) {
        try {
          const chunk = new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: (s.cts * 1_000_000) / s.timescale,
            duration: (s.duration * 1_000_000) / s.timescale,
            // EncodedVideoChunk's constructor copies `data` (per spec), so
            // releasing the mp4box sample below is safe.
            data: s.data,
          });
          videoChunkQueue.push({ chunk, sampleNumber: s.number });
          samplesIn++;
        } catch (e) { failPipeline(e, 'Decode'); return; }
      }
      // mp4box can drop the parsed sample bytes — we own copies now.
      inputFile.releaseUsedSamples(_id, samples[samples.length - 1].number + 1);
    } else if (user === 'audio' && audioOk && audioDesc) {
      for (const s of samples) {
        const chunk = new EncodedAudioChunk({
          type: 'key',
          timestamp: (s.cts * 1_000_000) / s.timescale,
          duration: (s.duration * 1_000_000) / s.timescale,
          data: s.data,
        });
        const meta = audioMetaSent ? undefined : {
          decoderConfig: {
            codec: audioTrack.codec,
            numberOfChannels: audioTrack.audio.channel_count,
            sampleRate: audioTrack.audio.sample_rate,
            description: audioDesc,
          },
        };
        muxer.addAudioChunk(chunk, meta as any);
        audioMetaSent = true;
      }
      inputFile.releaseUsedSamples(_id, samples[samples.length - 1].number + 1);
    }
  };

  inputFile.start();
  phase('mp4box.started');

  // -------- Pump: drain the chunk queue into the decoder, with backpressure --------
  // Caps both the decoder and encoder queue depths. Each decoded frame holds
  // GPU memory (a texture); without these caps a moov-at-end file dumps
  // 40k+ frames into the encoder queue, exhausts VRAM and triggers a GPU
  // reset (visible as a screen flash on macOS). Keep the numbers small.
  const MAX_DECODE_QUEUE = 6;
  const MAX_ENCODE_QUEUE = 3;

  const pumpDone = (async () => {
    while (!cancelled && !pipelineErr) {
      if (videoChunkQueue.length === 0) {
        if (allVideoSamplesEmitted) break;
        await new Promise((r) => setTimeout(r, 15));
        continue;
      }
      while (
        (decoder.decodeQueueSize > MAX_DECODE_QUEUE ||
         encoder.encodeQueueSize > MAX_ENCODE_QUEUE) &&
        !cancelled && !pipelineErr
      ) {
        await new Promise((r) => setTimeout(r, 15));
      }
      if (cancelled || pipelineErr) break;
      const next = videoChunkQueue.shift();
      if (!next) continue;
      try {
        decoder.decode(next.chunk);
        lastDecodedSample = next.sampleNumber;
      } catch (e) { failPipeline(e, 'Decode'); break; }
    }
    phase('pump.complete', `queue drained · ${samplesIn} chunks fed`);
  })();

  // Heartbeat + stall watchdog. Every second we report queue depths and
  // counter snapshots; if we stop making forward progress for STALL_LIMIT
  // seconds, we kill the pipeline with a useful error rather than letting
  // the user stare at a frozen progress bar.
  const STALL_LIMIT = 30;
  let lastProgressSnapshot = -1;
  let stallSeconds = 0;
  const heartbeat = setInterval(() => {
    if (pipelineErr || cancelled) return;
    post({
      type: 'heartbeat',
      samplesIn,
      framesDecoded,
      chunksEncoded,
      decoderQueue: decoder.decodeQueueSize,
      encoderQueue: encoder.encodeQueueSize,
      decoderState: decoder.state,
      encoderState: encoder.state,
    });
    const snapshot = samplesIn * 1_000_000 + framesDecoded * 1000 + chunksEncoded;
    if (snapshot === lastProgressSnapshot) {
      stallSeconds++;
      if (stallSeconds >= STALL_LIMIT) {
        failPipeline(
          new Error(
            `Pipeline stopped making progress for ${STALL_LIMIT}s. ` +
            `samples-in=${samplesIn}, frames-decoded=${framesDecoded}, chunks-encoded=${chunksEncoded}. ` +
            `decoder=${decoder.state}/q${decoder.decodeQueueSize}, encoder=${encoder.state}/q${encoder.encodeQueueSize}.`
          ),
          'Pipeline'
        );
      }
    } else {
      stallSeconds = 0;
      lastProgressSnapshot = snapshot;
    }
  }, 1000);

  // Wait for the stream-feed to finish so all samples have been emitted by mp4box.
  await feedDone;
  phase('feed.awaited');

  if (cancelled) throw new Error('Cancelled');
  if (pipelineErr) throw pipelineErr;

  // Tell the pump that no more chunks will arrive — it can finish once the
  // queue is empty, instead of polling forever waiting for new chunks.
  allVideoSamplesEmitted = true;

  // The pump is still draining the chunk queue → decoder → encoder → muxer.
  // While it works, leave the label honest — we ARE still encoding.
  post({ type: 'status', label: 'Encoding · draining' });

  await pumpDone;
  if (cancelled) throw new Error('Cancelled');
  if (pipelineErr) throw pipelineErr;

  // Now flush WebCodecs' own internal buffers (the last few frames in flight).
  try { await decoder.flush(); } catch (e) { failPipeline(e, 'Decode'); }
  try { decoder.close(); } catch {}
  try { await encoder.flush(); } catch (e) { failPipeline(e, 'Encode'); }
  try { encoder.close(); } catch {}

  clearInterval(heartbeat);
  if (pipelineErr) throw pipelineErr;
  if (cancelled) throw new Error('Cancelled');

  // NOW the heavy lifting is done — muxer.finalize() is fast (just writing
  // the moov atom). This is the real "Finalising" moment.
  post({ type: 'status', label: 'Finalising', pct: 97 });
  phase('mux.finalize');
  muxer.finalize();
  phase('mux.done');

  const buf = (muxer.target as ArrayBufferTarget).buffer;
  lastBlob = new Blob([buf], { type: 'video/mp4' });
}

// ---------- Helpers ----------

// Extract the avcC / hvcC config record bytes from a track's sample description.
// IMPORTANT: mp4box's DataStream over-allocates its buffer (grows in chunks),
// so `buffer.slice(8)` would include trailing zero padding that VideoDecoder
// rejects with a generic "Decoding error.". Slice using `position`, which is
// exactly where box.write() stopped writing.
function extractCodecBox(trak: any): Uint8Array | undefined {
  const entries = trak?.mdia?.minf?.stbl?.stsd?.entries;
  if (!entries) return;
  for (const entry of entries) {
    const box = entry.avcC || entry.hvcC;
    if (!box) continue;
    const ds = new (MP4Box as any).DataStream(undefined, 0, (MP4Box as any).DataStream.BIG_ENDIAN);
    box.write(ds);
    const written: number = ds.position ?? ds.byteLength ?? ds.buffer.byteLength;
    return new Uint8Array(ds.buffer, 8, written - 8);
  }
}

// Extract the AAC AudioSpecificConfig bytes from an mp4a sample entry's esds box.
function extractAacConfig(trak: any): Uint8Array | undefined {
  const entries = trak?.mdia?.minf?.stbl?.stsd?.entries;
  if (!entries) return;
  for (const entry of entries) {
    const esds = entry.esds;
    if (!esds) continue;
    // esds → ESDescriptor (tag 3) → DecoderConfigDescriptor (tag 4) → DecoderSpecificInfo (tag 5)
    const desc = esds.esd?.descs?.[0]?.descs?.[0];
    if (desc?.data) {
      return desc.data instanceof Uint8Array ? desc.data : new Uint8Array(desc.data);
    }
  }
}
