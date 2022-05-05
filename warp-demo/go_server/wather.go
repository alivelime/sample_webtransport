package main

import (
	"log"
	"strings"

	"github.com/fsnotify/fsnotify"
)

const MEDIA_DIR = "../media"
const INIT_VIDEO_MP4 = "../media/init-stream0.m4s"
const INIT_AUDIO_MP4 = "../media/init-stream1.m4s"
const VIDEO_FILE_PREFIX = "chunk-stream0"
const AUDIO_FILE_PREFIX = "chunk-stream1"

// add watcher for ffmpeg HLS
func watch(sender Sender) error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}

	go func() {
		for {
			select {
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}
				switch {
				case event.Op&fsnotify.Create == fsnotify.Create:
					if strings.Contains(event.Name, ".tmp") {
						continue
					}
					if strings.Contains(event.Name, VIDEO_FILE_PREFIX) {
						sender.SendVideo(event.Name)
					}
					if strings.Contains(event.Name, AUDIO_FILE_PREFIX) {
						sender.SendAudio(event.Name)
					}
				}
			case err, ok := <-watcher.Errors:
				if !ok {
					return
				}
				log.Println("error: ", err)
				return
			}
		}
	}()

	err = watcher.Add(MEDIA_DIR)
	if err != nil {
		return err
	}
	return nil
}
