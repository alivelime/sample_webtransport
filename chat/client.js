// Adds an entry to the event log on the page, optionally applying a specified
// CSS class.

let name;


// "Connect" button handler.
async function connect() {
  const url = document.getElementById('url').value;
  try {
    var transport = new WebTransport(url + '/chat');
    addToEventLog('Initiating connection...');
  } catch (e) {
    addToEventLog('Failed to create connection object. ' + e, 'error');
    return;
  }

  try {
    await transport.ready;
    addToEventLog('Connection ready.');
  } catch (e) {
    addToEventLog('Connection failed. ' + e, 'error');
    return;
  }

  transport.closed
      .then(() => {
        addToEventLog('Connection closed normally.');
      })
      .catch(() => {
        addToEventLog('Connection closed abruptl.', 'error');
      });

  acceptUnidirectionalStreams(transport);

  // enter
  sendData(transport, {
    command: "enter",
    name: document.getElementById('name').value,
  });

  // set send comment button.
  document.getElementById('send').onclick = async function sendComment() {
    let form = document.forms.sending.elements;
    let encoder = new TextEncoder('utf-8');
    let rawData = sending.comment.value;

    // $B%3%a%s%H$rAw?.$9$k(B
    sendData(transport, {
      command: "comment",
      comment: rawData,
    })
  }

  // set connection close on window closed or reload.
  window.addEventListener('unload', (event) => {
    disconnect(transport);
  })
  setUIConnected();
}

function disconnect(transport) {
  if (transport) {
    transport.close();
    transport = null;
  }
}

async function sendData(transport, data) {
  let stream = await transport.createUnidirectionalStream();
  let writer = stream.getWriter();
  await writer.write(new TextEncoder("utf-8").encode(JSON.stringify(data)));
  await writer.close();
  addToEventLog('Sent a unidirectional stream with data: ' + JSON.stringify(data));
}


// ストリームを受け付ける
async function acceptUnidirectionalStreams(transport) {
  let reader = transport.incomingUnidirectionalStreams.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        addToEventLog('Done accepting unidirectional streams!');
        return;
      }
      let stream = value;
      readFromIncomingStream(stream);
    }
  } catch (e) {
    addToEventLog('Error while accepting streams: ' + e, 'error');
  }
}

// データを読み込む
async function readFromIncomingStream(stream) {
  let decoder = new TextDecoderStream('utf-8');
  let reader = stream.pipeThrough(decoder).getReader();
  try {
    let buffer = new Uint8Array();
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        // ここではvalueは空になる
        //
        // jsonでデータをやり取りする
        let data = JSON.parse(buffer);
        addCommentViewer(data);
        return;
      }
      buffer += value;
      addToEventLog('Received data on stream : ' + value);
    }
  } catch (e) {
    addToEventLog(
      'Error while reading from stream : ' + e, 'error');
    addToEventLog('    ' + e.message);
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
function addCommentViewer(data) {
  let comments = document.getElementById('comment-viewer');
  let mostRecentEntry = comments.lastElementChild;

  let entry = document.createElement('div');
  entry.className = 'comment-line';

  let name = document.createElement('div');
  name.innerText = data.name;
  name.className = 'comment-line-name';
  entry.appendChild(name);

  let comment = document.createElement('div');
  comment.innerText = data.comment;
  comment.className = 'comment-line-comment';
  entry.appendChild(comment);

  comments.appendChild(entry);

  // If the most recent entry in the log was visible, scroll the log to the
  // newly added element.
  if (mostRecentEntry != null &&
      mostRecentEntry.getBoundingClientRect().top <
          comments.getBoundingClientRect().bottom) {
    entry.scrollIntoView();
  }
}
function setUIConnected() {
  document.getElementById('connection-panel').style.display = 'none';
  document.getElementById('comment-panel').style.display = 'block';
}

