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
    
    // データグラムを受け取る
    readDatagram(wt_video, async (payload) => {
      // 動画をフレームごとに受信する。

      // payloadからデータを復元する
      // header(17) = type(1byte) + timestamp(8) + duration(8)
      let view = new DataView(payload);
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
    
    // データグラムを受け取る
    readDatagram(wt_audio, async (payload) => {
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

// データグラムを受け取る
async function readDatagram(transport, onstream) {
  let size = new Array(), count = new Array();
  let buffer = new Array(); // ストリームとパケット番号ごとにデータをいれる
  let reader = transport.datagrams.readable.getReader();

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      self.postMessage('Done read datagram.');
      return;
    }
    const data = value;

    // 最初の8バイトを取得して、ストリーム番号とパケット番号を取得する
    let view = new DataView(data.buffer);
    const stream_number = view.getUint32(0);
    const packet_number = view.getUint32(4);

    // 初めての来たストリームデータなら、バッファを初期化する
    if (!(stream_number in  buffer)) {
      buffer[stream_number] = new Array();
      size[stream_number] = Number.MAX_SAFE_INTEGER; // 最初はストリームの全体の長さがわからない
      count[stream_number] = 0
    }

    // 最初のパケットにはデータの長さを入れてある
    if (packet_number === 0) {
      size[stream_number] = view.getUint32(8);
      // console.log(`${stream_number} ${packet_number} ${size[stream_number]}`);
      continue;
    }

    buffer[stream_number][packet_number-1] = data.slice(8); // ストリーム番号とパケット番号を除いた残りのデータ全てコピーする
    count[stream_number] += data.byteLength - 8
    
    // ストリームのデータが全部揃ったら処理をする(データが全部来なかった時のことはとりあえず考えない)
    // console.log(`${stream_number} ${packet_number} ${count[stream_number]}/${size[stream_number]}`);
    if (size[stream_number] === count[stream_number]) {
      // console.log(new Date(Date.now()).toISOString() + "stream readed! " + stream_number);
      
      // 前のフレームがまだ残っている場合は先に処理してしまう。
      if (stream_number-1 in buffer) {
        self.postMessage(`stream ${stream_number - 1} skipped!`);
        concatFrame(buffer, size, count, stream_number - 1, onstream);
      }
      concatFrame(buffer, size, count, stream_number, onstream);
    }
  }
  let payload = new Uint8Array();
}
function concatFrame(buffer, size, count,  stream_number, onstream) {
  const buf = buffer[stream_number];
  const length = size[stream_number];

    // データを結合する
    let payload = new Uint8Array(length);
    let pos = 0;
    for (let i = 0; pos < length; i++) {
      // データがあればそれを使う。なければ0で埋める
      if (i in buf) {
        payload.set(new Uint8Array(buf[i]), pos);
        pos += buf[i].byteLength;
      } else {
        console.log(i);
        let dummy = new ArrayBuffer(pos + 1000 < length ? 1000 : length - 1000); 
        payload.set(new Uint8Array(dummy), pos);
        pos += dummy.byteLength;
      }
    }

    // データを処理する
    onstream(payload.buffer);

    // 使い終わったバッファは削除する
    delete buffer[stream_number];
    delete size[stream_number];
    delete count[stream_number];
}
