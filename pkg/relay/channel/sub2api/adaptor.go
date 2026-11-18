package sub2api

import (
	"github.com/LingByte/miniseadrama/pkg/relay/channel/newapi"
)

type Adaptor struct {
	newapi.Adaptor
}

func (a *Adaptor) GetModelList() []string {
	return ModelList
}

func (a *Adaptor) GetChannelName() string {
	return ChannelName
}
