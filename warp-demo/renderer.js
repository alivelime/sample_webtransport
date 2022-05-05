
class Renderer {
  start(stream, delay, kind) {
      this.kind = kind
      this.queue = [];
      this.baseTime = 0;
      this.frameWriter = stream.getWriter();
      this.timeStart = performance.now() + delay
      this.firstTimestamp = 0

      /*
      const calcNextTime = (timestamp) => {
        let mediaTime = performance.now() - this.baseTime;
        return Math.max(0, timestamp / 1000 - mediaTime);
      }*/
  }
  /*
  async render() {
    if (this.underflow()) return;
    const frame = this.queue.shift();

    const wait = calcNextTime(frame.timestamp);
    await new Promise((r) => {
      setTimeout(r, wait);
    });
    this.frameWriter.write(frame);
    frame.close();

    setTimeout(this.render, 0);
  }
  */
  onframe(frame) {
    if (!this.firstTimestamp) {
      this.firstTimestamp = frame.timestamp - 1; // 0除算を避けるため1ずらしておく
    }

    const diff = Number(this.timeStart + ((frame.timestamp - this.firstTimestamp) / 1000) - performance.now())

    // フレームが早ければ待つ。フレームレート内のタイミングであれば描画する、遅ければ読み飛ばす
    if (diff > 0) {
      if (this.kind === "video") {
        // console.log(diff)
      }
      setTimeout(
        () => {
          this.frameWriter.write(frame);
          frame.close();
        },
        diff
      )
    } else {
      console.log("frame skipped. " + diff)
      // 描画すべき時刻をすぎている場合は読み飛ばす
    }
  }
  underflow() {
    return this.queue.length === 0
  }
}
