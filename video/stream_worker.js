let stopped = false;
let wt_video = null;
let wt_audio = null;

self.addEventListener('message', async (e) => {
  const type = e.data.type;

  if (type === "connect") {
    stopped = false;
    const {media: {video, audio}, url} = e.data;

    wt_video = new WebTransport(url + '/video/stream');
    wt_audio = new WebTransport(url + '/audio/stream');
    await wt_video.ready;
    await wt_audio.ready;
    wt_video.closed.then(() => {
        self.postMessage('video Connection closed normally.');
      })
      .catch(() => {
        self.postMessage('video Connection closed abruptl.');
      });
    wt_audio.closed.then(() => {
        self.postMessage('audio Connection closed normally.');
      })
      .catch(() => {
        self.postMessage('audio Connection closed abruptl.');
      });
    // 送信のみなのでストリームの受け入れは不要

    streamVideo(video);
    streamAudio(audio);
    return;
  }
  if (type === "stop") {
    stopped = true;
    wt_video.close();
    wt_audio.close();
  }

}, false)

// 動画をフレームごとに送信する。
async function streamVideo(video) {

  const frameReader = video.stream.getReader();
  self.postMessage('Start video frame encode.');
  
  let encodedFrameCount = 0;
  let encoder = new VideoEncoder({
      output: (chunk) => {
        // 1フレーム送信する (分割・結合はQUICにお任せする)
        if (stopped) {
          return;
        }

        // header(17) = type(1byte) + timestamp(8) + duration(8)
        let payload = new ArrayBuffer(17 + chunk.byteLength);
        const view = new DataView(payload);
        view.setUint8(0, (chunk.type === "key" ? 1 : 2));
        view.setBigInt64(1, BigInt(chunk.timestamp)); // 仕様では long long だが実際はNumber
        view.setBigUint64(9, BigInt(chunk.duration)); // 仕様では unsigned long long だが実際はNumber
        chunk.copyTo(new DataView(payload, 17));

        // フレームを送信する
        sendBinaryData(wt_video, payload);

        if (encodedFrameCount++ % 30 == 0) {
          self.postMessage(`Video Encode 30 frames and send chunk. ${frameCount - encodedFrameCount} ${chunk.type} size ${chunk.byteLength} ${chunk.timestamp} ${chunk.duration}`)
        }
      },
      error: (e) => {
        self.postMessage("encoding error. " + e.message)
      }
    });
  encoder.configure({
    codec: 'vp8', // これしか使えない
    width: video.width,
    height: video.height,
    framerate: 1,
    latencyMode: "realtime",
  });

  let frameCount = 0;
  try {
    while(true) {
      if (stopped) {
        frameReader.close();
        encoder.close();
        self.postMessage("frame stream stopped.");
        break;
      }
      const {value, done} = await frameReader.read();
      if (done) {
        self.postMessage("frame stream ended.");
        break;
      }
      var frame = value;
      encoder.encode(frame, {keyFrame: (frameCount % 30 == 0 ? true : false)});
      frame.close();
     if (frameCount++ % 150 == 0) {
        self.postMessage(`Read 150 frames. last frame = ${frameCount - encodedFrameCount}`);
      }
    }
  } catch (e) {
    self.postMessage('Video frame read failed. ' + e);
  }
  wt_video.close();
}

async function streamAudio(audio) {
  const frameReader = audio.stream.getReader();
  self.postMessage('Start audio frame encode.');
  
  let encodedFrameCount = 0;
  let encoder = new AudioEncoder({
      output: (chunk) => {
        // 1フレーム送信する (分割・結合はQUICにお任せする)
        if (stopped) {
          return;
        }

        // header(17) = type(1byte) + timestamp(8) + duration(8)
        let payload = new ArrayBuffer(17 + chunk.byteLength);
        const view = new DataView(payload);
        view.setUint8(0, (chunk.type === "key" ? 1 : 2));
        view.setBigInt64(1, BigInt(chunk.timestamp)); // 仕様では long long だが実際はNumber
        view.setBigUint64(9, BigInt(chunk.duration)); // 仕様では unsigned long long だが実際はNumber
        chunk.copyTo(new DataView(payload, 17));

        // フレームを送信する
        sendBinaryData(wt_audio, payload);

        if (encodedFrameCount++ % 30 == 0) {
          self.postMessage(`Audio Encode 30 frames and send chunk. ${frameCount - encodedFrameCount} size ${chunk.byteLength} ${chunk.timestamp} ${chunk.duration}`)
        }
      },
      error: (e) => {
        self.postMessage("encoding error. " + e.message)
      }
    });
  encoder.configure({
    codec: 'opus',
    numberOfChannels: 2,
    sampleRate: 48000, // audioCtx.sampleRate,
  });

  let frameCount = 0;
  try {
    while(true) {
      if (stopped) {
        frameReader.close();
        encoder.close();
        self.postMessage("frame stream stopped.");
        break;
      }
      const {value, done} = await frameReader.read();
      if (done) {
        self.postMessage("frame stream ended.");
        break;
      }
      var frame = value;
      encoder.encode(frame);
      frame.close();
     if (frameCount++ % 150 == 0) {
        self.postMessage(`Read 150 frames. last frame = ${frameCount - encodedFrameCount}`);
      }
    }
  } catch (e) {
    self.postMessage('Video frame read failed. ' + e);
  }
  wt_audio.close();
}

// バイナリデータを送信する
async function sendBinaryData(transport, data) {
  let stream = await transport.createUnidirectionalStream();
  let writer = stream.getWriter();
  await writer.write(data);
  await writer.close();
}
