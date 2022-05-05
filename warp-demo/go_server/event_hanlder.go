package main

import (
	"bytes"
	"context"
	"io/ioutil"
	"log"

	"github.com/lucas-clemente/quic-go"
	"github.com/lucas-clemente/quic-go/quicvarint"
)

type EventHandler interface {
	run()
}

type WarpVideo struct {
	session quic.Session
	sender  Sender
  stop <-chan interface{}
}

func (c *WarpVideo) run() {
	c.sender.AddViewer(c.session)
  go func() {
    <- c.stop
    c.sender.RemoveViewer(c.session)
  }()
}

type WarpAudio struct {
	session quic.Session
	sender  Sender
  stop <-chan interface{}
}

func (c *WarpAudio) run() {
	c.sender.AddListener(c.session)
  go func() {
    <- c.stop
    c.sender.RemoveListener(c.session)
  }()
}

type DatagramEcho struct {
	session quic.Session
}

func (c *DatagramEcho) run() {
	go c.read()
}

func (c *DatagramEcho) read() {
	for {
		msg, err := c.session.ReceiveMessage()
		if err != nil {
			log.Println(err)
			break
		}

		// echo
		{
			buf := &bytes.Buffer{}
			buf.Write(msg)
			err = c.session.SendMessage(buf.Bytes())
			if err != nil {
				log.Println(err)
			}
		}
	}
}

type StreamEcho struct {
	session quic.Session
	ctx     context.Context
}

func (c *StreamEcho) run() {
	go c.read()
}

func (c *StreamEcho) read() {
	for {
		stream, err := c.session.AcceptUniStream(c.ctx)
		if err != nil {
			log.Println(err)
			return
		}
		//log.Println("accept stream.")

		go func(stream quic.ReceiveStream) {
			// read heder
			qr := quicvarint.NewReader(stream)
			sty, err := quicvarint.Read(qr)
			if err != nil {
				log.Println(err)
				return
			}
			//log.Printf("\tStreamType: %# x\r\n", sty)
			if sty != STREAM_TYPE_WEBTRANSPORT_UNI {
				return
			}
			sid, err := quicvarint.Read(qr)
			if err != nil {
				log.Println(err)
				return
			}

			// log.Printf("accept stream id %d, session %d.", stream.StreamID(), sid)

			// echo by uni stream.
			res, err := c.session.OpenUniStream()
			if err != nil {
				log.Println(err)
				return
			}
			// log.Printf("open %d stream.", res.StreamID())
			defer res.Close()

			h := &bytes.Buffer{}
			quicvarint.Write(h, STREAM_TYPE_WEBTRANSPORT_UNI)
			quicvarint.Write(h, uint64(sid))
			res.Write(h.Bytes())

			buf, err := ioutil.ReadAll(stream)
			if err != nil {
				log.Println(err)
			}
			res.Write(buf)
		}(stream)
	}
}
