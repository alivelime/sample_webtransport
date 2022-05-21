# Warp Demo
This is warp demo.

# How to use

1. make directory and set movie and font file.

```shell
$ cd {work directory}
$ mkdir media movie server
$ cd movie && wget https://mirror.clarkson.edu/blender/demo/movies/BBB/bbb_sunflower_1080p_30fps_normal.mp4
$ cp {your system font directory/arial font file} ./arial.ttf
```

2. make build and set cert file.

```shell
$ cd go_server
$ go build
$ cp echo {work directory}/server/
$ cp {your certification public key}  {work directory}/server/
$ cp {your certification private key}  {work directory}/server/
```

3. run ffmpeg and server.

```shell
$ (install ffmpeg...)
$ cd {work directory}/movie
$ cd ../media && ffmpeg -re -stream_loop -1 -i ../movie/bbb_sunflower_1080p_30fps_normal.mp4 \
    -vf "drawtext=fontfile=../movie/arial.ttf: text='%{localtime\:%X}_%{frame_num}': r=24: fontsize=60: fontcolor=white: x=(w-tw)/2: y=h-(2*lh): box=1: boxcolor=0x00000000@1" \
    -ac 2 -acodec aac -vcodec libx264 -threads 2 -b:v 500k \
    -r 30 -seg_duration 0.5 -g 15 -x264-params open-gop=0 -refs 0 -bf 0 \
    -sc_threshold 0 -b_strategy 0 -strftime 1 -use_template 1 \
    -window_size 5 -hls_playlist 1 -streaming 1 -remove_at_exit 1 -f dash manifest.mpd

$ cd {work directory}/server
$ ./echo
```

4. set webserver document root.
5. access by chrome browser.


### optional use SRT.

1. run ffmpeg with SRT instead of bbb.mp4 file.

```shell
$ cd ../media && ffmpeg -re -i "srt://:4201?mode=listener&latency=120" \
    -acodec copy -vcodec copy -threads 2 \
    -strftime 1 -use_template 1 -seg_duration 0.5 \
    -window_size 5 -hls_playlist 1 -streaming 1 -remove_at_exit 1 -f dash manifest.mpd
```

2. broadcast SRT
Use OSB or ffmpeg or somethin.

```shell
# broadcast on mac
$ cd movie/ && ffmpeg -re -stream_loop -1 -i bbb_sunflower_1080p_30fps_normal.mp4 \
    -vf "drawtext=fontfile=arial.ttf: \
        text='%{localtime\:%X}_%{frame_num}': r=24: fontsize=60: fontcolor=white: \
        x=(w-tw)/2: y=h-(2*lh): box=1: boxcolor=0x00000000@1" \
    -ac 2 -acodec aac -vcodec h264_videotoolbox -threads 6 -b:v 500k \
     -r 30 -seg_duration 0.5 -g 15 -x264-params open-gop=0 -refs 0 -bf 0 \
    -sc_threshold 0 -b_strategy 0 \
    -tune zerolatency \
    -f flv  \
    "srt://{your host ip address}:4201?pkt_size=1316"
```
