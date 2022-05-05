const nbSamples = 10

class Warp {
  constructor(kind, renderer) {
    this.kind = kind
    this.initMP4 = null
    this.id = null
    this.renderer = renderer
    this.stream_id = null
  }
  async connect(host) {
    this.wt = new WebTransport(`${host}/${this.kind}/stream`)
    await this.wt.ready
    this.wt.closed.then(() => console.log(`Warp ${kind} connection `))

    this.decoder = this.kind === 'video'
      ? new VideoDecoder({
        output : frame => {
          this.renderer.onframe(frame, this.kind);
        },
        error : e => console.error(e),
      })
    : new AudioDecoder({
        output : frame => {
          this.renderer.onframe(frame, this.kind);
        },
        error : e => console.error(e),
      });
  }

  onframe(chunk) {
    this.decoder.decode(chunk);
    /*
    const now = performance.now()
    const time = this.kine === "video"
      ? this.timeVideo
      : this.timeAudio
    if (now - time > 10.0) {
      console.log("on frame to decode : " + (now - time))
    }
    this.kine === "video"
      ? this.timeVideo = now
      : this.timeAudio = now
      */
  }
  async accept() {
    let reader = this.wt.incomingUnidirectionalStreams.getReader()
    let sid = 0
    this.timeVideo = performance.now()
    this.timeAudio = performance.now()
    try {
      while (true) {
        //  console.log("wait stream")
        const {value, done} = await reader.read()
        if (done) {
          console.log("Done accept unidirectional streams.")
          return
        }
        const stream = value;
        // ストリームから読み取り、ここは新しいストリームを優先させるため await しない
        (async () => {
          // console.log("accept stream")
          let segmentType = ""
          const reader = stream.getReader()

          // read message
          const { value, done } = await reader.read()
          if (done) {
            console.log("error: empty stream.")
            return
          }
          const msg_len = new DataView(value.buffer, 0).getInt8(0)
          // console.log(msg_len)
          console.log(new TextDecoder().decode(value.slice(1, 1 + msg_len)))
          const message = JSON.parse(new TextDecoder().decode(value.slice(1, 1 + msg_len)))
          const timeStart = performance.now()
          if (message.init !== undefined) {
            segmentType = 'init'
            this.id = message.init.id
            // 最初のinitの読み込み完了を待つ
            this.initMP4 = new Promise(async (resolve, reject) => {
              let payload = value.slice(1 + msg_len, value.byteLength);
              let length = payload.byteLength;
              while (true) {
                const { value, done } = await reader.read()
                if (done) {
                  console.log("init mp4 : " + (performance.now() - timeStart))
                  resolve(payload)
                  return
                }
                length += value.byteLength;
                let buffer = new Uint8Array(payload.byteLength + value.byteLength);
                buffer.set(payload, 0);
                buffer.set(new Uint8Array(value), payload.byteLength);
                payload = buffer;
              }
            });
            console.log("received init.mp4")
            return
          } else if (message.segment !== undefined) {
            if (this.kind === "video") {
              // console.log("segment " + this.kind + " : " + (timeStart - this.timeVideo))
              this.timeVideo = timeStart
            } else {
              // console.log("segment " + this.kind + " : " + (timeStart - this.timeAudio))
              this.timeAudio = timeStart
            }
            let demuxer = new MP4Demuxer(sid++, await this.initMP4, this.kind, this.onframe, nbSamples); 

            demuxer.source.onframe = this.onframe.bind(this);
            segmentType = "segment"
            if (message.segment.init !== this.id) {
              console.log("error, different init id. " + this.id + " : " + message.segment.init)
              return
            }
            await demuxer.getConfig().then(async (config) => {
              if (this.kind === 'video') {
                self.postMessage({
                  type: "play",
                  width: config.codedWidth,
                  height: config.codedHeight,
                })
              }

              this.decoder.configure(config);
            });
            demuxer.ondata(value.slice(1 + msg_len, value.byteLength), false)
            demuxer.start()
            while (true) {
              const { value, done } = await reader.read()
              if (done) {
                console.log("stream done " + (sid-1) + " : " + (performance.now() - timeStart))
                break
              }
              demuxer.ondata(value, true)
            }
          } else {
            console.log("unknown type message. ")
            console.log(message)
            return
          }
        })()
      }
    } catch (err) {
      console.log("accept incoming unidirectional stream. " + err)
    }
  }
  stop() {
    this.wt.close()
  }
}
