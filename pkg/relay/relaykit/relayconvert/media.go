package relayconvert

import relaymedia "github.com/LingByte/miniseadrama/pkg/relay/relaykit/relayconvert/internal/media"

type MediaResolver = relaymedia.MediaResolver

func SetMediaResolver(resolver MediaResolver) {
	relaymedia.SetMediaResolver(resolver)
}
