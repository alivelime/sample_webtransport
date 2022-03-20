package main

// reference
// https://github.com/yomorun/yomo-presence-backend/blob/main/pkg/server/webtransport.go

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/lucas-clemente/quic-go"
	"github.com/lucas-clemente/quic-go/quicvarint"
	"github.com/marten-seemann/qpack"
)

func main() {
	cert, err := tls.LoadX509KeyPair("cert.pem", "cert.key")
	if err != nil {
		log.Println(err)
		return
	}
	certs := []tls.Certificate{cert}
	wt := NewWebTransportServer()
	wtErr := make(chan error)

	addr := "0.0.0.0:4433"
	go func() {
		// WebTransport Server. (UDP)
		wtErr <- wt.Serve(addr, certs)
	}()

	select {
	case err := <-wtErr:
		log.Println(err)
		return
	}
}

const STREAM_TYPE_CONTROL = 0x00
const STREAM_TYPE_WEBTRANSPORT_UNI = 0x54
const FRAME_TYPE_HEADER = 0x01
const FRAME_TYPE_SETTINGS = 0x04
const H3_DATAGRAM = 0xffd277
const ENABLE_WEBTRANSPORT = 0x2b603742

type WebTransportServer struct {
}

func NewWebTransportServer() WebTransportServer {
	return WebTransportServer{}
}

func (wt *WebTransportServer) Serve(addr string, certs []tls.Certificate) error {
	tlsConfig := &tls.Config{
		Certificates: certs,
		NextProtos:   []string{"h3"},
	}
	quicConfig := &quic.Config{
		EnableDatagrams: true,
	}

	listener, err := quic.ListenAddr(addr, tlsConfig, quicConfig)
	if err != nil {
		return err
	}
	log.Printf("WebTransport server listening on %s", listener.Addr().String())

	for {
		sess, err := listener.Accept(context.Background())
		if err != nil {
			log.Println(err)
			continue
		}
		log.Printf("+Session: %s", sess.RemoteAddr().String())
		go wt.handleSession(sess)
	}
}

func (tw *WebTransportServer) Close() {
	log.Println("server close().")
}

func (wt *WebTransportServer) handleSession(sess quic.Session) {

	// https://www.ietf.org/archive/id/draft-ietf-webtrans-http3-02.html#section-2
	// 2. Protocol Overview
	// When an HTTP/3 connection is established, both the client and server have to send a SETTINGS_ENABLE_WEBTRANSPORT setting in order to indicate that they both support WebTransport over HTTP/3.

	// WebTransport sessions are initiated inside a given HTTP/3 connection by the client, who sends an extended CONNECT request [RFC8441]. If the server accepts the request, an WebTransport session is established.
	// all the first is create a http3 connection:

	// https://quicwg.org/base-drafts/draft-ietf-quic-http.html#section-6
	// In version 1 of QUIC, the stream data containing HTTP frames is carried by QUIC STREAM frames, but this framing is invisible to the HTTP framing layer.

	// right now, a QUIC connection has been established. So we focus on HTTP frames.

	// https://quicwg.org/base-drafts/draft-ietf-quic-http.html#section-3.2
	// While connection-level options pertaining to the core QUIC protocol are set in the initial crypto handshake, HTTP/3-specific settings are conveyed in the SETTINGS frame. After the QUIC connection is established, a SETTINGS frame (Section 7.2.4) MUST be sent by each endpoint as the initial frame of their respective HTTP control stream; see Section 6.2.1.

	// 1. send setting frame. ENABLE_WEBTRANSPORT
	wt.sendSettingFrame(sess)

	//  2. recv setting frame.
	wt.receiveSettingFrame(sess)

	conn, err := wt.receiveClientConnect(sess)
	if err != nil {
		log.Println("HTTP CONNECT failed", err)
		return
	}

	if conn != nil {
		log.Println("conn run")
		conn.run()
	}
	log.Println("Prepared! Start to work...")
}

func (wt *WebTransportServer) sendSettingFrame(sess quic.Session) {
	log.Printf("[1] Send SETTINGS frame")

	// https://www.ietf.org/archive/id/draft-ietf-webtrans-http3-02.html#section-3.1
	// In order to indicate support for WebTransport, both the client and the server MUST send a SETTINGS_ENABLE_WEBTRANSPORT value set to "1" in their SETTINGS frame.
	// [1] send SETTINGS frame
	// https://www.w3.org/TR/webtransport/#webtransport-constructor
	// 6. Wait for connection to receive the first SETTINGS frame, and let settings be a dictionary that represents the SETTINGS frame.
	// 7. If settings doesn’t contain SETTINGS_ENABLE_WEBTRANPORT with a value of 1, or it doesn’t contain H3_DATAGRAM with a value of 1, then abort the remaining steps and queue a network task with transport to run these steps:

	respStream, err := sess.OpenUniStream()
	if err != nil {
		log.Println(err)
		return
	}

	buf := &bytes.Buffer{}

	// A control stream is indicated by a stream type of 0x00. Data on this stream consists of HTTP/3 frames, as defined in Section 7.2.
	// Each side MUST initiate a single control stream at the beginning of the connection and send its SETTINGS frame as the first frame on this stream. If the first frame of the control stream is any other frame type, this MUST be treated as a connection error of type H3_MISSING_SETTINGS. Only one control stream per peer is permitted; receipt of a second stream claiming to be a control stream MUST be treated as a connection error of typ
	quicvarint.Write(buf, STREAM_TYPE_CONTROL)

	// https://quicwg.org/base-drafts/draft-ietf-quic-http.html#name-http-framing-layer
	// 7. HTTP Framing Layer
	// HTTP/3 Frame Format {
	// 	 Type (i),
	// 	 Length (i),
	// 	 Frame Payload (..),
	// }
	// https://quicwg.org/base-drafts/draft-ietf-quic-http.html#name-settings
	// 7.2.4. SETTINGS
	// The SETTINGS frame (type=0x04) conveys configuration parameters that affect how endpoints communicate, such as preferences and constraints on peer behavior. Individually, a SETTINGS parameter can also
	quicvarint.Write(buf, FRAME_TYPE_SETTINGS)

	var l uint64
	// H3_DATAGRAM
	// https://datatracker.ietf.org/doc/html/draft-ietf-masque-h3-datagram-05#section-9.1
	// +==============+==========+===============+=========+
	// | Setting Name | Value    | Specification | Default |
	// +==============+==========+===============+=========+
	// | H3_DATAGRAM  | 0xffd277 | This Document | 0       |
	// +--------------+----------+---------------+---------+
	l += uint64(quicvarint.Len(H3_DATAGRAM) + quicvarint.Len(1))
	// SETTINGS_ENABLE_WEBTRANPORT
	// https://www.ietf.org/archive/id/draft-ietf-webtrans-http3-02.html#section-8.2
	// The SETTINGS_ENABLE_WEBTRANSPORT parameter indicates that the specified HTTP/3 connection is
	// WebTransport-capable.
	// Setting Name:ENABLE_WEBTRANSPORT
	// Value:0x2b603742
	// Default:0
	l += uint64(quicvarint.Len(ENABLE_WEBTRANSPORT) + quicvarint.Len(1))

	quicvarint.Write(buf, l)

	// Write value
	// https://quicwg.org/base-drafts/draft-ietf-quic-http.html#name-settings
	// The payload of a SETTINGS frame consists of zero or more parameters. Each parameter consists of a setting identifier and a value, both encoded as QUIC variable-length integers.
	//
	// Setting {
	//   Identifier (i),
	//   Value (i),
	// }

	// SETTINGS Frame {
	//   Type (i) = 0x04,
	//   Length (i),
	//   Setting (..) ...,
	// }
	//

	quicvarint.Write(buf, H3_DATAGRAM)
	quicvarint.Write(buf, 1)
	quicvarint.Write(buf, ENABLE_WEBTRANSPORT)
	quicvarint.Write(buf, 1)

	bbb := buf.Bytes()
	log.Printf("\t>>>bbb:[len=%d] %# x", len(bbb), bbb)

	n, err := respStream.Write(bbb)
	if err != nil {
		log.Println(err)
		return
	}

	log.Printf("\t>>>wrote n:%d", n)
	log.Printf("\tSettings frame sent !")
}

func (wt *WebTransportServer) receiveSettingFrame(sess quic.Session) {
	recvSettingStream, _ := sess.AcceptUniStream(sess.Context())
	log.Printf("[2] receive client SETTINGS frame")

	sqr := quicvarint.NewReader(recvSettingStream)
	//  control stream type
	sty, err := quicvarint.Read(sqr)
	if err != nil {
		log.Println(err)
		return
	}
	log.Printf("\tStreamType: %# x\r\n", sty)

	//
	ftype, err := quicvarint.Read(sqr)
	if err != nil {
		log.Println(err)
		return
	}
	log.Printf("\tFrameType: %# x\r\n", ftype)

	// setting length
	flen, err := quicvarint.Read(sqr)
	if err != nil {
		log.Println(err)
		return
	}
	log.Printf("\tLength: %# x(oct=%d)\r\n", flen, flen)

	payload := make(map[uint64]uint64)
	payloadBuf := make([]byte, flen)
	if _, err := io.ReadFull(recvSettingStream, payloadBuf); err != nil {
		log.Println(err)
		return
	}
	bb := bytes.NewReader(payloadBuf)
	for bb.Len() > 0 {
		id, err := quicvarint.Read(bb)
		if err != nil {
			log.Println(err)
			return
		}
		value, err := quicvarint.Read(bb)
		if err != nil {
			log.Println(err)
			return
		}
		payload[id] = value
		log.Printf("\tidentifier:%# x, value: %d (%# x)\r\n", id, value, value)
	}
}

func (wt *WebTransportServer) receiveClientConnect(sess quic.Session) (EventHandler, error) {
	ctx := context.Background()
	reqStream, err := sess.AcceptStream(ctx)
	log.Printf("[3] Recieve HTTP CONNECT from client")

	if err != nil {
		return nil, err
	}

	log.Printf("\trequest stream accepted: %d", reqStream.StreamID())

	qr := quicvarint.NewReader(reqStream)
	t, err := quicvarint.Read(qr)
	if err != nil {
		log.Println(err)
		return nil, err
	}
	log.Printf("\tt: %# x", t)

	ll, err := quicvarint.Read(qr)
	if err != nil {
		log.Println(err)
		return nil, err
	}
	log.Printf("\tll: %# x", ll)

	if t != FRAME_TYPE_HEADER {
		// header frame
		log.Println("\tnot header frame, should force close connection!!!!!")
		return nil, errors.New("not header frame")
	}

	headerBlock := make([]byte, ll)
	var n int
	if n, err = io.ReadFull(reqStream, headerBlock); err != nil {
		return nil, err
	}
	log.Printf("\tn: %d", n)
	decoder := qpack.NewDecoder(nil)
	headers, err := decoder.DecodeFull(headerBlock)
	if err != nil {
		return nil, err
	}

	// check header.
	var path string
	for k, v := range headers {
		log.Printf("\t[header] %d: %s", k, v)

		if v.Name == ":path" {
			path = v.Value
		}
	}

	var conn EventHandler
	u, err := url.Parse(path)
	if err != nil {
		log.Println("parse :path failed: ", err)
	}

	if u.Path == "/audio/echo/stream" {
		conn = &StreamEcho{session: sess, ctx: ctx}
	}
	if u.Path == "/video/echo/stream" {
		conn = &StreamEcho{session: sess, ctx: ctx}
	}
	if u.Path == "/audio/echo/datagram" {
		conn = &DatagramEcho{session: sess}
	}
	if u.Path == "/video/echo/datagram" {
		conn = &DatagramEcho{session: sess}
	}

	// response
	{
		status := http.StatusOK
		header := http.Header{}
		header.Add(":status", strconv.Itoa(status))
		header.Add("Sec-Webtransport-Http3-Draft", "draft02")
		var qpackHeaders bytes.Buffer
		encoder := qpack.NewEncoder(&qpackHeaders)
		for k, v := range header {
			log.Printf("\t[response header] %s: %s", k, v)
			for index := range v {
				log.Printf("\t[range v] v=%s, index=%d, v[index]=%s", v, index, v[index])
				encoder.WriteField(qpack.HeaderField{
					Name:  strings.ToLower(k),
					Value: v[index],
				})
			}
		}

		buf := &bytes.Buffer{}
		quicvarint.Write(buf, FRAME_TYPE_HEADER)
		quicvarint.Write(buf, uint64(qpackHeaders.Len()))
		log.Printf("\tresponse 200: %# x %# x", buf.Bytes(), qpackHeaders.Bytes())

		writer := bufio.NewWriter(reqStream)
		if n, err = writer.Write(buf.Bytes()); err != nil {
			return nil, err
		}
		log.Printf("\tn1=%d", n)
		if n, err = writer.Write(qpackHeaders.Bytes()); err != nil {
			return nil, err
		}
		if err = writer.Flush(); err != nil {
			return nil, err
		}
		log.Printf("\tn1=%d", n)
	}

	return conn, nil
}

type EventHandler interface {
	run()
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
		log.Println(len(msg))

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
		log.Println("accept stream.")

		go func(stream quic.ReceiveStream) {
			// read heder
			qr := quicvarint.NewReader(stream)
			sty, err := quicvarint.Read(qr)
			if err != nil {
				log.Println(err)
				return
			}
			log.Printf("\tStreamType: %# x\r\n", sty)
			if sty != STREAM_TYPE_WEBTRANSPORT_UNI {
				return
			}
			sid, err := quicvarint.Read(qr)
			if err != nil {
				log.Println(err)
				return
			}

			log.Printf("accept stream id %d, session %d.", stream.StreamID(), sid)

			// echo by uni stream.
			res, err := c.session.OpenUniStream()
			if err != nil {
				log.Println(err)
				return
			}
      log.Printf("open %d stream.", res.StreamID())
      defer res.Close()

			h := &bytes.Buffer{}
			quicvarint.Write(h, STREAM_TYPE_WEBTRANSPORT_UNI)
			quicvarint.Write(h, uint64(sid))
			res.Write(h.Bytes())

			for {

				buf := make([]byte, 1024)
				_, err := stream.Read(buf)
				if err != nil {
					log.Println(err)
					return
				}
//				log.Printf("read stream id %d, %d byte.", stream.StreamID(), n)

				// echo
				{
					res.Write(buf)
				}
			}
		}(stream)
	}
}
