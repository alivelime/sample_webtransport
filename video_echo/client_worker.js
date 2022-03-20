let stopped = false;
let wt_video = null;
let wt_audio = null;
let packet_sent = 0;
let packet_recv = 0;
let packet_lost = 0;

self.addEventListener('message', async (e) => {
  const type = e.data.type;

  if (type === "connect") {
    stopped = false;

    const {media: {video, audio}, url, sendtype} = e.data;

    wt_video = new WebTransport(`${url}/video/echo/${sendtype}`);
    wt_audio = new WebTransport(`${url}/audio/echo/${sendtype}`);
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

    sendVideo(video, sendtype);
    sendAudio(audio, sendtype);
    return;
  }
  if (type === "stop") {
    stopped = true;
    wt_video.close();
    wt_audio.close();
  }

}, false)

// encode video and send frame.
async function sendVideo(video, sendtype) {
  let datagramWriter = wt_video.datagrams.writable.getWriter();

  const frameReader = video.sendStream.getReader();
  self.postMessage('Start video frame encode.');
  
  let encodedFrameCount = 0;
  let encoder = new VideoEncoder({
      output: (chunk) => {
        // 1フレーム送信する (分割・結合はQUICにお任せする)
        if (stopped) {
          return;
        }

        // header(25) = type(1byte) + timestamp(8) + timestamp(8) + duration(8)
        let payload = new ArrayBuffer(25 + chunk.byteLength);
        const view = new DataView(payload);
        view.setUint8(0, (chunk.type === "key" ? 1 : 2));
        view.setBigInt64(1, BigInt(Date.now()));
        view.setBigInt64(9, BigInt(chunk.timestamp)); // 仕様では long long だが実際はNumber
        view.setBigUint64(17, BigInt(chunk.duration)); // 仕様では unsigned long long だが実際はNumber
        chunk.copyTo(new DataView(payload, 25));

        // フレームを送信する
        (sendtype === 'stream'
          ? sendStream(wt_video, payload)
          : sendDatagram(datagramWriter, encodedFrameCount, payload)
        );

        if (encodedFrameCount++ % 30 == 0) {
          // self.postMessage(`Video Encode 30 frames and send chunk. ${frameCount - encodedFrameCount} ${chunk.type} size ${chunk.byteLength} ${chunk.timestamp} ${chunk.duration}`)
        }
      },
      error: (e) => {
        self.postMessage("encoding error. " + e.message)
      }
    });
  encoder.configure({
    codec: (video.codec === 'vp8' ? 'vp8'
      : video.codec === 'vp9' ? 'vp09.00.10.08'
      : video.codec ===  'h264' ? 'avc1.64001E'
      : 'vp8'
    ),
    avc: (video.codec === 'h264'
      ? { format: "annexb" }
      : undefined
    ),
    width: video.width,
    height: video.height,
    latencyMode: "realtime",
  });

  recvVideo(video, sendtype);
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
      encoder.encode(frame, {keyFrame: (frameCount % 150 == 0 ? true : false)});
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

async function sendAudio(audio, sendtype) {
  let datagramWriter = wt_audio.datagrams.writable.getWriter();

  const frameReader = audio.sendStream.getReader();
  self.postMessage('Start audio frame encode.');
  
  let encodedFrameCount = 0;
  let encoder = new AudioEncoder({
      output: (chunk) => {
        // 1フレーム送信する (分割・結合はQUICにお任せする)

        if (stopped) {
          return;
        }

        // header(25) = type(1byte) + timestamp(8) + timestamp(8) + duration(8)
        let payload = new ArrayBuffer(25 + chunk.byteLength);
        const view = new DataView(payload);
        view.setUint8(0, (chunk.type === "key" ? 1 : 2));
        view.setBigInt64(1, BigInt(Date.now()));
        view.setBigInt64(9, BigInt(chunk.timestamp)); // 仕様では long long だが実際はNumber
        view.setBigUint64(17, BigInt(chunk.duration)); // 仕様では unsigned long long だが実際はNumber
        chunk.copyTo(new DataView(payload, 25));

        // フレームを送信する
        (sendtype === 'stream'
          ? sendStream(wt_audio, payload)
          : sendDatagram(datagramWriter, encodedFrameCount,  payload)
        );

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
    numberOfChannels: audio.numberOfChannels,
    sampleRate: audio.sampleRate,
  });

  recvAudio(audio, sendtype);
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
      encoder.encode(frame, {keyFrame: (frameCount % 150 == 0 ? true : false)});
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
async function recvVideo(video, sendtype) {
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
        codec: (video.codec === 'vp8' ? 'vp8'
          : video.codec === 'vp9' ? 'vp09.00.10.08'
          : video.codec ===  'h264' ? 'avc1.64001E'
          : 'vp8'
        ),
        avc: (video.codec === 'h264'
          ? { format: "annexb" }
          : undefined
        ),
        optimizeForLatency: true,
      });
    };
    decoder = newVideoDecoder(frameWriter, onerror);
    decoder.configure({
      codec: (video.codec === 'vp8' ? 'vp8'
        : video.codec === 'vp9' ? 'vp09.00.10.08'
        : video.codec ===  'h264' ? 'avc1.64001E'
        : 'vp8'
      ),
      avc: (video.codec === 'h264'
        ? { format: "annexb" }
        : undefined
      ),
      optimizeForLatency: true,
    });
    
    // ストリームを受け付ける
    const onframe =  (payload) => {
      // 動画をフレームごとに受信する。

      // payloadからデータを復元する
      // header(25) = type(1byte) + timestamp(8) + duration(8)
      let view = new DataView(payload, 0);
      const type = view.getUint8(0);
      const latency = Date.now() - Number(view.getBigInt64(1));
      const chunk = new EncodedVideoChunk({
        type: (type === 1 ? 'key' : 'delta'),
        timestamp: Number(view.getBigInt64(9)), // 仕様では long long だが実際はNumber
        duration: Number(view.getBigInt64(17)), // 仕様では unsigned long long だが実際はNumber
        data: new DataView(payload, 25),
      });
      
     if (frameCount++ % 30 == 0) {
        self.postMessage(`Video: Received 30 frames. latency: ${latency}, last frame = ${frameCount - decodedFrameCount}, size: ${chunk.byteLength}, time: ${chunk.timestamp}, duration: ${chunk.duration},`);
      }
      // key frameが来るまで読み飛ばす
      if (wait_keyframe && type === 1) {
        self.postMessage(`Video: Received key frames. latency: ${latency}, last frame = ${frameCount - decodedFrameCount}, size: ${chunk.byteLength}, time: ${chunk.timestamp}, duration: ${chunk.duration}`);
        wait_keyframe = false;
      }
      if (!wait_keyframe && (frameCount - decodedFrameCount < 30)) {
        try {
          decoder.decode(chunk);
        } catch(e) {
          onerror(e);
        }
      } else {
        // skip frame and wait next key frame.
        console.log(`skip frame ${wait_keyframe} ${frameCount} ${decodedFrameCount}`);
        decodedFrameCount++;
        wait_keyframe = true;
      }
    };
    (sendtype === 'stream'
      ? acceptUnidirectionalStreams(wt_video, onframe)
      : readDatagram(wt_video, onframe)
    );
}

async function recvAudio(audio, sendtype) {
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
      numberOfChannels: audio.numberOfChannels,
      sampleRate: audio.sampleRate,
    });
  };
  decoder = newAudioDecoder(audioWriter, onerror);
  decoder.configure({
    codec: audio.codec,
    numberOfChannels: audio.numberOfChannels,
    sampleRate: audio.sampleRate,
  });
    
    // ストリームを受け付ける
    const onframe = (payload) => {
      // 音声をフレームごとに受信する。

      // payloadからデータを復元する
      // header(25) = type(1byte) + timestamp(8) + timestamp(8) + duration(8)
      let view = new DataView(payload, 0);
      const type = view.getUint8(0);
      const latency = Date.now() - Number(view.getBigInt64(1));
      const chunk = new EncodedAudioChunk({
        type: (type === 1 ? 'key' : 'delta'),
        timestamp: Number(view.getBigInt64(9)), // 仕様では long long だが実際はNumber
        duration: Number(view.getBigInt64(17)), // 仕様では unsigned long long だが実際はNumber
        data: new DataView(payload, 25),
      });
      
     if (frameCount++ % 30 == 0) {
        self.postMessage(`Audio: Received 30 frames. latency: ${latency}, last frame = ${frameCount - decodedFrameCount}, size: ${chunk.byteLength}, time: ${chunk.timestamp}, duration: ${chunk.duration},`);
      }
      if (wait_keyframe && type === 1) {
        self.postMessage(`Audio: Received key frames. latency: ${latency}, last frame = ${frameCount - decodedFrameCount}, size: ${chunk.byteLength}, time: ${chunk.timestamp}, duration: ${chunk.duration}`);
        wait_keyframe = false;
      }
      if (!wait_keyframe && (frameCount - decodedFrameCount < 30)) {
        try {
          decoder.decode(chunk);
        } catch(e) {
          onerror(e);
        }
      } else {
        // skip frame and wait next key frame.
        decodedFrameCount++;
        wait_keyframe = true;
      }
    };
    (sendtype === 'stream'
      ? acceptUnidirectionalStreams(wt_audio, onframe)
      : readDatagram(wt_audio, onframe)
    );
}

// バイナリデータを送信する
async function sendStream(transport, data) {
  let stream = await transport.createUnidirectionalStream();
  let writer = stream.getWriter();
  await writer.write(data);
  await writer.close();
}
async function sendDatagram(datagramWriter, stream_number, data) {
  // データフォーマット
  // stream_number(4)
  // packet_number(4)
  // data(n)
  const size = data.byteLength;

  // 最初にパケット番号0としてデータの長さを送る
  let header = new ArrayBuffer(4 + 4 + 4);
  const view = new DataView(header);
  view.setUint32(0, stream_number);
  view.setUint32(4, 0); // パケット番号0はデータ全体の長さとする
  view.setUint32(8, size);
  datagramWriter.write(header);

  let count = 0;
  for (let i = 0; i < size; ) {
    const len = (size > i + 1000) ? 1000 : size - i;
    let payload = new Uint8Array(8 + len);
    const view = new DataView(payload.buffer);
    view.setUint32(0, stream_number);
    view.setUint32(4, ++count);
    payload.set(new Uint8Array(data, i, len), 8);

    datagramWriter.write(payload.buffer);
    i += len;
  }
  packet_sent += count;
}

// ストリームを受け付ける
async function acceptUnidirectionalStreams(transport, onframe) {
  let reader = transport.incomingUnidirectionalStreams.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        self.postMessage('Done accepting unidirectional streams!');
        return;
      }
      let stream = value;
      await readFromIncomingStream(stream, onframe);
    }
  } catch (e) {
    self.postMessage('Error while accepting streams: ' + e);
  }
}
// データを読み込む
async function readFromIncomingStream(stream, onframe) {
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
      onframe(payload.buffer);
      return;
    }
    count++; length += value.byteLength;
    buffer = new Uint8Array(payload.byteLength + value.byteLength);
    buffer.set(payload, 0);
    buffer.set(new Uint8Array(value), payload.byteLength);
    payload = buffer;
  }
}
// データグラムを受け取る
async function readDatagram(transport, onframe) {
  let size = new Array(), count = new Array();
  let buffer = new Array(); // フレームとパケット番号ごとにデータをいれる
  let reader = transport.datagrams.readable.getReader();

  while (true) {
    const { value, done } = await reader.read();
    packet_recv++;
    if (done) {
      self.postMessage('Done read datagram.');
      return;
    }
    const data = value;

    // 最初の8バイトを取得して、フレーム番号とパケット番号を取得する
    let view = new DataView(data.buffer);
    const frame_number = view.getUint32(0);
    const packet_number = view.getUint32(4);

    // 初めての来たフレームデータなら、バッファを初期化する
    if (!(frame_number in  buffer)) {
      buffer[frame_number] = new Array();
      size[frame_number] = 0; // 最初はフレームの全体の長さがわからない
      count[frame_number] = 0
    }

    // 最初のパケットにはデータの長さを入れてある
    if (packet_number === 0) {
      size[frame_number] = view.getUint32(8);
      // console.log(`${frame_number} ${packet_number} ${size[frame_number]}`);
      continue;
    }

    buffer[frame_number][packet_number-1] = data.slice(8); // フレーム番号とパケット番号を除いた残りのデータ全てコピーする
    count[frame_number] += data.byteLength - 8
    
    // フレームのデータが全部揃ったら処理をする(データが全部来なかった時のことはとりあえず考えない)
    // console.log(`${frame_number} ${packet_number} ${count[frame_number]}/${size[frame_number]}`);
    if (size[frame_number] === count[frame_number]) {
      
      // 前のフレームがまだ残っている場合は先に処理してしまう。
      if (frame_number-1 in buffer) {
        self.postMessage(`stream ${frame_number - 1} skipped!`);
        concatFrame(buffer, size, count, frame_number - 1, onframe);
      }
      concatFrame(buffer, size, count, frame_number, onframe);
    }
  }
}
function concatFrame(buffer, size, count,  frame_number, onframe) {
  const buf = buffer[frame_number];
  let length = size[frame_number];
  if (length === undefined || !buf) { 
      self.postMessage(`skipped frame ${frame_number}`);
      return; 
  }
  // フレームの全体の長さがわからない場合は、欠損率は5%くらいと考える
  if (length === 0) {
    length = parseInt(buf.length * 1.05 * 1000);
  }

    // データを結合する
    let payload = new Uint8Array(length);
    let pos = 0;
    for (let i = 0; pos < length; i++) {
      try {
        // データがあればそれを使う。なければ0で埋める
        if (i in buf) {
          payload.set(new Uint8Array(buf[i]), pos);
          pos += buf[i].byteLength;
        } else {
          packet_lost++;
          self.postMessage(`packet lost frame ${frame_number}, packet ${i}. ${packet_lost} ${(packet_lost)/(packet_lost + packet_recv)}`);
          let dummy = new ArrayBuffer(pos + 1000 < length ? 1000 : length - pos); 
          pos += dummy.byteLength;
          payload.set(new Uint8Array(dummy), pos);
        }
      } catch(e) {
        console.log(e);
        console.log(`${i} ${length} ${pos}`);
        if (i > 10000) {
          throw 'aa';
        }
      }
    }

    // データを処理する
    onframe(payload.buffer);

    // 使い終わったバッファは削除する
    delete buffer[frame_number];
    delete size[frame_number];
    delete count[frame_number];
}

