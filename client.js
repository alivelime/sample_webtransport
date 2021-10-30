// Adds an entry to the event log on the page, optionally applying a specified
// CSS class.

let wt, streamNumber, datagramWriter;

async function connect() {
  try {
    const url = document.getElementById("url").value;
    wt = new WebTransport(url);
    addToEventLog('Initiating connection...');
    await wt.ready;
    addToEventLog('Connection ready.');

    wt.closed
      .then(() => {setUIStart(); addToEventLog('Connection closed normally.'); })
      .catch(() => {setUIStart(); addToEventLog('Connection closed abruptly.', 'error')});

    streamNumber = 1;
    datagramWriter = wt.datagrams.writable.getWriter();
    
    readDatagrams();
    acceptUnidirectionalStreams();

    setUIConnected();
  } catch (e) {
    addToEventLog(`Connection failed. ${e}`, 'error');
  }
}
async function sendData() {
  const form = document.forms.sending.elements;
  const rawData = sending.data.value;
  const data = new TextEncoder("utf-8").encode(rawData);
  try {
    switch (form.sendtype.value) {
      case "datagram": {
        await datagramWriter.write(data);
        addToEventLog(`Sent datagram: ${rawData}`);
        break;
      }
      case "unidi" : {
        const writable = await wt.createUnidirectionalStream();
        const writer = writable.getWriter();
        await writer.write(data);
        await writer.close();
        addToEventLog(`Sent a unidirectional stream with data: ${rawData}`);
        break;
      }
      case "bidi": {
        const duplexStream = await wt.createBidirectionalStream();
        const n = streamNumber++;
        readFromIncomingStream(duplexStream.readable, n);
        
        const writer = duplexStream.writable.getWriter();
        await writer.write(data);
        await writer.close();
        addToEventLog(`Sent bidirectional stream #${n} with data: ${rawData}`);

        break;
      }
    }
  } catch (e) {
    addToEventLog(`Error while sending data: ${e}`, 'error');
  }
}

async function readDatagrams() {
  try {
    /*
    const decoder = new TextDecoderStream("utf-8");
    for await (const data of wt.datagrams.readable.pipeThrough(decoder)) {
      addToEventLog(`Datagram received: ${data}`);
    }
    */
    let decoder = new TextDecoder("utf-8");
    let reader = wt.datagrams.readable.getReader();
    while(true) {
      const {value, done} = await reader.read();
      if (done) {
        addToEventLog('Done reading datagrams!');
        return;
      }
      let data = decoder.decode(value);
      addToEventLog(`Datagram received: ${data}`);
    }
  } catch (e) {
    addToEventLog(`Error while reading datagrams: ${e}`, 'error');
  }
}

async function acceptUnidirectionalStreams() {
  try {
    /*
    for await (const readable of wt.incomingUnidirectionalStreams) {
      const number = streamNumber++;
      addToEventLog(`New incoming unidirectional stream #${number}`);
      readFromIncomingStream(readable, number);
    }
    */
    let reader = wt.incomingUnidirectionalStreams.getReader();
    while (true) {
      const {value, done} = await reader.read();
      if (done) {
         addToEventLog('Done accepting unidirectional streams!');
        return;
      }
      let readable = value;
      let number = streamNumber++;
      addToEventLog(`New incoming unidirectional stream #${number}`);
      readFromIncomingStream(readable, number);
    }
  } catch (e) {
    addToEventLog(`Error while accepting streams ${e}`, 'error');
  }
}
async function readFromIncomingStream(readable, number) {
  try {
    /*
    const decoder = new TextDecoderStream("utf-8");
    for await (const chunk of readable.pipeThrough(decoder)) {
      addToEventLog(`Received data on stream #${number}: ${chunk}`);
    }
    */
    let decoder = new TextDecoderStream("utf-8");
    let reader = readable.pipeThrough(decoder).getReader();
    while (true) {
      const {value, done} = await reader.read();
      if (done) {
        addToEventLog('Stream #' + number + ' closed');
        return;
      }
      let data = value;
      addToEventLog(`Received data on stream #${number}: ${data}`);
    }
  } catch (e) {
    addToEventLog(`Error while reading from stream #${number}: ${e}`, 'error');
    addToEventLog(`    ${e.message}`);
  }
}

function addToEventLog(text, severity = 'info') {
  let log = document.getElementById('event-log');
  let mostRecentEntry = log.lastElementChild;
  let entry = document.createElement('li');
  entry.innerText = text;
  entry.className = 'log-' + severity;
  log.appendChild(entry);

  // If the most recent entry in the log was visible, scroll the log to the
  // newly added element.
  if (mostRecentEntry != null &&
      mostRecentEntry.getBoundingClientRect().top <
          log.getBoundingClientRect().bottom) {
    entry.scrollIntoView();
  }
}
function setUIStart() {
  document.forms.sending.elements.send.disabled = true;
  document.getElementById('connect').disabled = false;
}
function setUIConnected() {
  document.forms.sending.elements.send.disabled = false;
  document.getElementById('connect').disabled = true;
}

