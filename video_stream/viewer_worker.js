let stopped = false;
let wait_keyframe = true;
let wt_video = null, frameWriter = null;
let wt_audio = null, audioWriter = null;

self.addEventListener('message', async (e) => {
  const type = e.data.type;

  if (type === "connect") {
    self.postMessage('Start video audio frame receive.');

    stopped = false;
    wait_keyframe = true;
    const {media: {video, audio}, url} = e.data;

    wt_video = new WebTransport(url + '/video/view');
    wt_audio = new WebTransport(url + '/audio/view');
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

    streamVideo(video);
    streamAudio(audio);

    return;
  }
  if (type === "stop") {
    self.postMessage('Stop video frame receive.');
    stopped = true;
    frameWriter.close();
    audioWriter.close();
    wt_video.close();
    return;
  }
}, false)

// 音声を取得してデコードする

// ビデオを取得してデコードする
async function streamVideo(video) {

    // デコーダーの準備
    frameWriter = video.stream.getWriter();
    let frameCount = 0;
    let decodedFrameCount = 0;
    let decoder = new VideoDecoder({
        output: (frame) => {
          frameWriter.write(frame);
          decodedFrameCount++
        },
        error: (e) => {
          console.log(e);
          self.postMessage(e)
        }
      });
    decoder.configure({
      codec: 'vp8', // これしか使えない
      optimizeForLatency: true,
    });
    
    // ストリームを受け付ける
    acceptUnidirectionalStreams(wt_video, async (payload) => {
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
        self.postMessage(`Received 30 frames. last frame = ${frameCount - decodedFrameCount}, ${chunk.type}, ${chunk.byteLength} ${chunk.timestamp} ${chunk.duration}`);
      }
      // key frameが来るまで読み飛ばす
      if (wait_keyframe && type === 1) {
        self.postMessage(`Received key frames. last frame = ${frameCount - decodedFrameCount}, ${chunk.type}, ${chunk.byteLength} ${chunk.timestamp} ${chunk.duration}`);
        wait_keyframe = false;
      }
      if (!wait_keyframe) {
        decoder.decode(chunk);
      }
    });
}
async function streamAudio(audio) {

    // デコーダーの準備
    audioWriter = audio.stream.getWriter();
    let frameCount = 0;
    let decodedFrameCount = 0;
    let decoder = new AudioDecoder({
        output: (frame) => {
          audioWriter.write(frame);
          decodedFrameCount++
        },
        error: (e) => {
          console.log(e);
          self.postMessage(e)
        }
      });
    decoder.configure({
      codec: 'opus',
      numberOfChannels: 2,
      sampleRate: 48000, // audioCtx.sampleRate,
    });
    
    // ストリームを受け付ける
    acceptUnidirectionalStreams(wt_audio, async (payload) => {
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
        self.postMessage(`Received 30 audio. last frame = ${frameCount - decodedFrameCount}, ${chunk.type}, ${chunk.byteLength} ${chunk.timestamp} ${chunk.duration}`);
      }
      decoder.decode(chunk);
    });
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
      // 1フレームずつ順番に処理するのでとりあえず待つ
      readFromIncomingStream(stream, onstream);
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
        self.postMessage(`invalid payload ${length} ${count}`);
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
