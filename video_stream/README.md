# WebTransport echo example

This is a video and audio broadcast sample based on [Google Chrome Sample](https://github.com/googlechrome/samples/tree/gh-pages/webtransport).

more info [Qiita]()https://qiita.com/alivelime/items/ebf6da9ce2b929ec2251

# feature

- video broadcast
- audio broadcast

# How to run

## Install

1. Download Canary
2. Install OepnSSL
3. Install Python3.x
4. Generate a certificate and a private key:

```shell
$ openssl req -newkey rsa:2048 -nodes -keyout certificate.key \
                   -x509 -out certificate.pem -subj '/CN=Test Certificate' \
                   -addext "subjectAltName = DNS:localhost"
```

5. Compute the fingerprint of the certificate:

```shell
$ openssl x509 -pubkey -noout -in certificate.pem |
  openssl rsa -pubin -outform der |
  openssl dgst -sha256 -binary | base64
```

6. Install Python library and fix.

```shell
$ pip3 install aioquic
```

## Launch server and canary

```shell
# server
$ python3 py_server/server.py certificate.pem certificate.key

# server for client
$ python3 -m http.server

# canary
/Applications/Google\ Chrome\ Canary.app/Contents/MacOS/Google\ Chrome\ Canary \
    --origin-to-force-quic-on=localhost:4433 \
    --ignore-certificate-errors-spki-list=[fingerprint]

# or Chrome Dev
/Applications/Google\ Chrome\ Dev.app/Contents/MacOS/Google\ Chrome\ Dev \
    --origin-to-force-quic-on=localhost:4433 \
    --ignore-certificate-errors-spki-list=[fingerprint]
```
access stream.html to stream video.
access viewer.html to watch viewo.


