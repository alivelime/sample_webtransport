class MP4Source {
  constructor(id, initMP4, kind, onframe, nbSamples) {
    this.id = id
    this.file = MP4Box.createFile();
    this.file.onError = console.error.bind(console);
    this.file.onReady = this.onReady.bind(this);
    this.file.onSamples = this.onSamples.bind(this);
    this.file.onSegment = null
    this.kind = kind;
    this.onframe = onframe;
    this.info = null;
    this._info_resolver = null;
    this.nbSamples = nbSamples

    this.timeStart = performance.now()
    this.isFirstChunk = true

    let buf = initMP4.buffer;
    this.offset = buf.byteLength;;
    buf.fileStart = 0;
    this.file.appendBuffer(buf);
  }
  ondata(value, process) {
    let buf = value.buffer;
    buf.fileStart = this.offset;
    this.offset += buf.byteLength;
    this.file.appendBuffer(buf);
    if (process) {
//      console.log("process samples.")
      this.file.processSamples(false)
    }
  }

  onReady(info) {
    // TODO: Generate configuration changes.
    this.info = info;

    if (this._info_resolver) {
      this._info_resolver(info);
      this._info_resolver = null;
    }
  }

  getInfo() {
    if (this.info)
      return Promise.resolve(this.info);

    return new Promise((resolver) => { this._info_resolver = resolver; });
  }

  getAvccBox() {
    // TODO: make sure this is coming from the right track.
    return this.file.moov.traks[0].mdia.minf.stbl.stsd.entries[0].avcC
  }

  start(track) {
    this.file.setExtractionOptions(track.id, '', {nbSamples: this.nbSamples});
    this.file.start();
  }

  onSamples(track_id, ref, samples) {
    for (const sample of samples) {
      const type = sample.is_sync ? "key" : "delta";
      if (this.isFirstChunk && type !== "key") {
        console.log("!!!!!!!!!!!! " + this.kind + "first frame is not iframe.")
      }
      this.isFirstChunk = false

//console.log(sample.dts);
      const chunk = this.isVideo()
        ? new EncodedVideoChunk({
          type: type,
          timestamp: sample.cts * (1000000 / sample.timescale),
          duration: sample.duration * (1000000 / sample.timescale),
          data: sample.data
        })
        : new EncodedAudioChunk({
          type: type,
          timestamp: sample.cts * (1000000 / sample.timescale),
          duration: sample.duration * (1000000 / sample.timescale),
          data: sample.data
        });

      this.onframe(chunk);
    }
    if (this.isVideo()) {
     // console.log("mp4 samples ." + this.id + " : " + (performance.now() - this.timeStart) )
    }
  }
  isVideo() {
    return this.kind === "video";
  }
  isAudio() {
    return this.kind === "audio";
  }
}

class Writer {
  constructor(size) {
    this.data = new Uint8Array(size);
    this.idx = 0;
    this.size = size;
  }

  getData() {
    if(this.idx != this.size)
      throw "Mismatch between size reserved and sized used"

    return this.data.slice(0, this.idx);
  }

  writeUint8(value) {
    this.data.set([value], this.idx);
    this.idx++;
  }

  writeUint16(value) {
    // TODO: find a more elegant solution to endianess.
    var arr = new Uint16Array(1);
    arr[0] = value;
    var buffer = new Uint8Array(arr.buffer);
    this.data.set([buffer[1], buffer[0]], this.idx);
    this.idx +=2;
  }

  writeUint8Array(value) {
    this.data.set(value, this.idx);
    this.idx += value.length;
  }
}

class MP4Demuxer {
  constructor(id, initMP4, kind, onframe, nbSamples) {
    this.kind = kind;
    this.source = new MP4Source(id, initMP4, kind, onframe, nbSamples);
  }

  getExtradata(avccBox) {
    var i;
    var size = 7;
    for (i = 0; i < avccBox.SPS.length; i++) {
      // nalu length is encoded as a uint16.
      size+= 2 + avccBox.SPS[i].length;
    }
    for (i = 0; i < avccBox.PPS.length; i++) {
      // nalu length is encoded as a uint16.
      size+= 2 + avccBox.PPS[i].length;
    }

    var writer = new Writer(size);

    writer.writeUint8(avccBox.configurationVersion);
    writer.writeUint8(avccBox.AVCProfileIndication);
    writer.writeUint8(avccBox.profile_compatibility);
    writer.writeUint8(avccBox.AVCLevelIndication);
    writer.writeUint8(avccBox.lengthSizeMinusOne + (63<<2));

    writer.writeUint8(avccBox.nb_SPS_nalus + (7<<5));
    for (i = 0; i < avccBox.SPS.length; i++) {
      writer.writeUint16(avccBox.SPS[i].length);
      writer.writeUint8Array(avccBox.SPS[i].nalu);
    }

    writer.writeUint8(avccBox.nb_PPS_nalus);
    for (i = 0; i < avccBox.PPS.length; i++) {
      writer.writeUint16(avccBox.PPS[i].length);
      writer.writeUint8Array(avccBox.PPS[i].nalu);
    }

    return writer.getData();
  }

  async getConfig() {
    let info = await this.source.getInfo();
    this.track = this.isVideo()
      ? info.videoTracks[0]
      : info.audioTracks[0];

    if (this.isVideo()) {
      var extradata = this.getExtradata(this.source.getAvccBox());
    }
    let config = this.isVideo() 
      ? {
        codec: this.track.codec,
        codedHeight: this.track.track_height,
        codedWidth: this.track.track_width,
        description: extradata,
      }
      : {
        codec: this.track.codec,
        numberOfChannels: this.track.audio.channel_count,
        sampleRate: this.track.audio.sample_rate,
      };

    return Promise.resolve(config);
  }

  start() {
    this.source.start(this.track);
  }
  ondata(data, process) {
    this.source.ondata(data, process)
  }
  isVideo() {
    return this.kind === "video";
  }
  isAudio() {
    return this.kind === "audio";
  }
}
