let stopped = false;
let wt_video = null;
let wt_audio = null;

self.addEventListener('message', async (e) => {
  const type = e.data.type;

  if (type === "connect") {
    stopped = false;

    const {media: {video, audio}, url} = e.data;

    wt_video = new WebTransport(url + '/video/echo');
    wt_audio = new WebTransport(url + '/audio/echo');
    await wt_video.ready;
    await wt_audio.ready;
    wt_video.closed.then(() => {
        self.postMessage('video recv Connection closed normally.');
      })
      .catch(() => {
        self.postMessage('video recv Connection closed abruptl.');
      });
    wt_audio.closed.then(() => {
        self.postMessage('audio recv Connection closed normally.');
      })
      .catch(() => {
        self.postMessage('audio recv Connection closed abruptl.');
      });
    // 送信のみなのでストリームの受け入れは不要

    sendVideo(video);
    sendAudio(audio);
    return;
  }
  if (type === "stop") {
    stopped = true;
    wt_video.close();
    wt_audio.close();
  }

}, false)

// encode video and send frame.
async function sendVideo(video) {

  const frameReader = video.sendStream.getReader();
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
          // self.postMessage(`Video Encode 30 frames and send chunk. ${frameCount - encodedFrameCount} ${chunk.type} size ${chunk.byteLength} ${chunk.timestamp} ${chunk.duration}`)
        }
      },
      error: (e) => {
        self.postMessage("encoding error. " + e.message)
      }
    });
  encoder.configure({
    codec: video.codec,
    width: video.width,
    height: video.height,
    latencyMode: "realtime",
  });

  recvVideo(video);
  let frameCount = 0;
  try {
    while(true) {
      if (stopped) {
        frameReader.close();
        encoder.close();
        self.postMessage("camera stream stopped.");
        break;
      }
      const {value, done} = await frameReader.read();
      if (done) {
        self.postMessage("camera stream ended.");
        break;
      }
      var frame = value;
      encoder.encode(frame, {keyFrame: (frameCount % 30 == 0 ? true : false)});
      frame.close();
     if (frameCount++ % 150 == 0) {
        // self.postMessage(`Read 150 frames. last frame = ${frameCount - encodedFrameCount}`);
      }
    }
  } catch (e) {
    self.postMessage('Camera frame read failed. ' + e);
  }
  wt_video.close();
}

async function sendAudio(audio) {
  const frameReader = audio.sendStream.getReader();
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
          // self.postMessage(`Audio Encode 30 frames and send chunk. ${frameCount - encodedFrameCount} size ${chunk.byteLength} ${chunk.timestamp} ${chunk.duration}`)
        }
      },
      error: (e) => {
        self.postMessage("encoding error. " + e.message)
      }
    });
  encoder.configure({
    codec: audio.codec,
    numberOfChannels: 1,
    sampleRate: 48000, // audioCtx.sampleRate,
  });

  recvAudio(audio);
  let frameCount = 0;
  try {
    while(true) {
      if (stopped) {
        frameReader.close();
        encoder.close();
        self.postMessage("mic stream stopped.");
        break;
      }
      const {value, done} = await frameReader.read();
      if (done) {
        self.postMessage("mic stream ended.");
        break;
      }
      var frame = value;
      encoder.encode(frame, {keyFrame: (frameCount % 30 == 0 ? true : false)});
      frame.close();
     if (frameCount++ % 150 == 0) {
        // self.postMessage(`Read 150 frames. last frame = ${frameCount - encodedFrameCount}`);
      }
    }
  } catch (e) {
    self.postMessage('Mic frame read failed. ' + e);
  }
  wt_audio.close();
}

// ビデオを取得してデコードする
async function recvVideo(video) {
    let wait_keyframe = true;

    // デコーダーの準備
    let frameWriter = video.recvStream.getWriter();
    let frameCount = 0;
    let decodedFrameCount = 0;
    let decoder = null;
    const newVideoDecoder = (frameWriter, onerror) =>
       new VideoDecoder({
        output: (frame) => {
          frameWriter.write(frame);
          decodedFrameCount++
        },
        error: onerror,
      });
    const onerror = (e) => {
      wait_keyframe = true;
      console.log(e);
      decoder = newVideoDecoder(frameWriter, onerror);
      decoder.configure({
        codec: video.codec,
        optimizeForLatency: true,
      });
    };
    decoder = newVideoDecoder(frameWriter, onerror);
    decoder.configure({
      codec: video.codec,
      optimizeForLatency: true,
    });
    
    // ストリームを受け付ける
    acceptUnidirectionalStreams(wt_video, (payload) => {
      // 動画をフレームごとに受信する。

      // payloadからデータを復元する
      // header(17) = type(1byte) + timestamp(8) + duration(8)
      let view = new DataView(payload, 0);
      const type = view.getUint8(0);
      const chunk = new EncodedVideoChunk({
        type: (type === 1 ? 'key' : 'delta'),
        timestamp: Number(view.getBigInt64(1)), // 仕様では long long だが実際はNumber
        duration: Number(view.getBigInt64(9)), // 仕様では unsigned long long だが実際はNumber
        data: new DataView(payload, 17),
      });
      
     if (frameCount++ % 30 == 0) {
        self.postMessage(`Video: Received 30 frames. last frame = ${frameCount - decodedFrameCount}, size: ${chunk.byteLength}, time: ${chunk.timestamp}, duration: ${chunk.duration}`);
      }
      // key frameが来るまで読み飛ばす
      if (wait_keyframe && type === 1) {
        self.postMessage(`Video: Received key frames. last frame = ${frameCount - decodedFrameCount}, size: ${chunk.byteLength}, time: ${chunk.timestamp}, duration: ${chunk.duration}`);
        wait_keyframe = false;
      }
      if (!wait_keyframe && (frameCount - decodedFrameCount < 10)) {
        try {
          decoder.decode(chunk);
        } catch(e) {
          onerror(e);
        }
      } else {
        // skip frame
        console.log(`skip frame ${wait_keyframe} ${frameCount} ${decodedFrameCount}`);
        decodedFrameCount = frameCount;
      }
    });
}

async function recvAudio(audio) {
  let wait_keyframe = true;

  // デコーダーの準備
  audioWriter = audio.recvStream.getWriter();
  let frameCount = 0;
  let decodedFrameCount = 0;

  // reset decoder when decode error.
  let decoder = null;
  const newAudioDecoder = (audioWriter, onerror) => 
     new AudioDecoder({
      output: (frame) => {
        audioWriter.write(frame);
        decodedFrameCount++
      },
      error: onerror,
    });
  const onerror = (e) => {
    wait_keyframe = true;
    console.log(e);
    self.postMessage(e)
    // reset decoder
    decoder = newAudioDecoder(audioWriter, onerror);
    decoder.configure({
      codec: audio.codec,
      numberOfChannels: 1,
      sampleRate: 48000, // audioCtx.sampleRate,
    });
  };
  decoder = newAudioDecoder(audioWriter, onerror);
  decoder.configure({
    codec: audio.codec,
    numberOfChannels: 1,
    sampleRate: 48000, // audioCtx.sampleRate,
  });
    
    // ストリームを受け付ける
    acceptUnidirectionalStreams(wt_audio, (payload) => {
      // 音声をフレームごとに受信する。

      // payloadからデータを復元する
      // header(17) = type(1byte) + timestamp(8) + duration(8)
      let view = new DataView(payload, 0);
      const type = view.getUint8(0);
      const chunk = new EncodedAudioChunk({
        type: (type === 1 ? 'key' : 'delta'),
        timestamp: Number(view.getBigInt64(1)), // 仕様では long long だが実際はNumber
        duration: Number(view.getBigInt64(9)), // 仕様では unsigned long long だが実際はNumber
        data: new DataView(payload, 17),
      });
      
     if (frameCount++ % 30 == 0) {
        self.postMessage(`Audio: Received 30 frames. last frame = ${frameCount - decodedFrameCount}, size: ${chunk.byteLength}, time: ${chunk.timestamp}, duration: ${chunk.duration}`);
      }
      if (wait_keyframe && type === 1) {
        self.postMessage(`Audio: Received key frames. last frame = ${frameCount - decodedFrameCount}, size: ${chunk.byteLength}, time: ${chunk.timestamp}, duration: ${chunk.duration}`);
        wait_keyframe = false;
      }
      if (!wait_keyframe && (frameCount - decodedFrameCount < 10)) {
        try {
          decoder.decode(chunk);
        } catch(e) {
          onerror(e);
        }
      } else {
        // skip frame
        decodedFrameCount = frameCount;
      }
    });
}

// バイナリデータを送信する
async function sendBinaryData(transport, data) {
  let stream = await transport.createUnidirectionalStream();
  let writer = stream.getWriter();
  await writer.write(data);
  await writer.close();
}

// ストリームを受け付ける
async function acceptUnidirectionalStreams(transport, onstream) {
  let reader = transport.incomingUnidirectionalStreams.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        self.postMessage('Done accepting unidirectional streams!');
        return;
      }
      let stream = value;
      await readFromIncomingStream(stream, onstream);
    }
  } catch (e) {
    self.postMessage('Error while accepting streams: ' + e);
  }
}
// データを読み込む
async function readFromIncomingStream(stream, onstream) {
  let reader = stream.getReader();
  let payload = new Uint8Array();
  let count = 0, length = 0;
  while (true) {
    const { value, done } = await reader.read();
    // console.log(typeof value === "undefined" ? -1 : value.byteLength);
    if (done) {
      // ここではvalueはundefinedになる

      // 1/30くらいの隔離で0バイトのデータになることがある?
      if (payload.byteLength == 0) {
        // console.log("invalud payload");
        self.postMessage(`invalid payload ${stream.id} ${count}`);
        return;
      }
      // 細かい処理はコールバックでやる
      onstream(payload.buffer);
      return;
    }
    count++; length += value.byteLength;
    buffer = new Uint8Array(payload.byteLength + value.byteLength);
    buffer.set(payload, 0);
    buffer.set(new Uint8Array(value), payload.byteLength);
    payload = buffer;
  }
}
