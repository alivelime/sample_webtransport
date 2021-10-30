# WebTransport echo example

This is a sample based on [Google Chrome Sample](https://github.com/googlechrome/samples/tree/gh-pages/webtransport).
But Chrome sample doesn't work.

more info [Qiita]()

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
$ vim /usr/local/lib/python3.9/site-packages/aioquic/h3/connection.p

# fix from
    H3_DATAGRAM = 0x276
# to
    H3_DATAGRAM = 0xffd277
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
```
