// Copyright (c) 2026 lingbyte. All rights reserved.

package pipeline

import (
	"context"

	"github.com/LingByte/miniseadrama/internal/pipeline/jobs"
)

func init() {
	jobs.Runner = func(job *jobs.Job) (map[string]any, error) {
		ctrl := &jobController{job: job}
		p := New(job.Params, job.Emit, ctrl)
		return p.Run(context.Background())
	}
}

type jobController struct{ job *jobs.Job }

func (c *jobController) Cancelled() bool { return c.job.IsCancelled() }
func (c *jobController) WaitIfPaused()   { c.job.WaitIfPaused() }
