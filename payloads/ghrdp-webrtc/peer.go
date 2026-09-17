package main

import (
	"github.com/pion/webrtc/v3"
)

func newPeerConnection() (*webrtc.PeerConnection, *webrtc.TrackLocalStaticSample, error) {
	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{
				"stun:stun.l.google.com:19302",
				"stun:stun1.l.google.com:19302",
			}},
		},
	}

	pc, err := webrtc.NewPeerConnection(config)
	if err != nil {
		return nil, nil, err
	}

	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeH264,
			ClockRate: 90000,
		},
		"video", "screen",
	)
	if err != nil {
		pc.Close()
		return nil, nil, err
	}

	if _, err = pc.AddTrack(track); err != nil {
		pc.Close()
		return nil, nil, err
	}

	return pc, track, nil
}
