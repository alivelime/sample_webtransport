package main

import (
	"bytes"
	"io/ioutil"
	"log"

	"github.com/lucas-clemente/quic-go"
	"github.com/lucas-clemente/quic-go/quicvarint"
)

type Sender interface {
	AddViewer(session quic.Session)
	AddListener(session quic.Session)
	RemoveViewer(session quic.Session)
	RemoveListener(session quic.Session)
	SendVideo(filename string)
	SendAudio(filename string)
}

type HlsSender struct {
	initMP4Video []byte
	initMP4Audio []byte
	viewer       map[string]quic.Session
	listener     map[string]quic.Session
}

func NewHlsSender() *HlsSender {
	// read init mp4 file
	v, err := ioutil.ReadFile(INIT_VIDEO_MP4)
	if err != nil {
		log.Fatal(err)
		return nil
	}
	a, err := ioutil.ReadFile(INIT_AUDIO_MP4)
	if err != nil {
		log.Fatal(err)
		return nil
	}

	return &HlsSender{
		initMP4Video: v,
		initMP4Audio: a,
		viewer:       make(map[string]quic.Session),
		listener:     make(map[string]quic.Session),
	}
}

func (s *HlsSender) AddViewer(session quic.Session) {
	s.viewer[session.RemoteAddr().String()] = session
	s.send(s.initMP4Video, []byte(`{"init": {"id": 0}}`), map[string]quic.Session{session.RemoteAddr().String(): session})
}
func (s *HlsSender) AddListener(session quic.Session) {
	s.listener[session.RemoteAddr().String()] = session
	s.send(s.initMP4Audio, []byte(`{"init": {"id": 1}}`), map[string]quic.Session{session.RemoteAddr().String(): session})
}
func (s *HlsSender) RemoveViewer(session quic.Session) {
      delete(s.viewer, session.RemoteAddr().String())
}
func (s *HlsSender) RemoveListener(session quic.Session) {
      delete(s.listener, session.RemoteAddr().String())
}

func (s *HlsSender) SendVideo(fn string) {
	s.sendFile(fn, []byte(`{"segment": {"init":0, "timestamp":0}}`), s.viewer)
}
func (s *HlsSender) SendAudio(fn string) {
	s.sendFile(fn, []byte(`{"segment": {"init":1, "timestamp":0}}`), s.listener)
}
func (s *HlsSender) sendFile(fn string, payload []byte, sessions map[string]quic.Session) {
	// read m4s file
	buf, err := ioutil.ReadFile(fn)
	if err != nil {
		log.Println(err)
		return
	}
	s.send(buf, []byte(payload), sessions)
}
func (s *HlsSender) send(buf, payload []byte, sessions map[string]quic.Session) {
	// send m4s by stream.
	for addr, session := range sessions {
		go func(addr string, sessions map[string]quic.Session) {
			stream, err := session.OpenUniStream()
			if err != nil {
				log.Println("delete ", addr, " ", err)
				delete(sessions, addr)
				return
			}
			defer stream.Close()
			 log.Println("send " + addr)

			h := &bytes.Buffer{}
			quicvarint.Write(h, STREAM_TYPE_WEBTRANSPORT_UNI)
			quicvarint.Write(h, uint64(0))
			stream.Write(h.Bytes())

			stream.Write([]byte{byte(len(payload))})
			stream.Write(payload)
			stream.Write(buf)
		}(addr, sessions)
	}
}
