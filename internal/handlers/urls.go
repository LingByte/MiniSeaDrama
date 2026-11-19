// Copyright (c) 2026 lingbyte. All rights reserved.

package handlers

import (
	"context"
	"time"

	"github.com/LingByte/miniseadrama/internal/configs"
	"github.com/LingByte/miniseadrama/pkg/apidocs/humax"
	"github.com/LingByte/miniseadrama/pkg/common/eventbus"
	"github.com/LingByte/miniseadrama/pkg/common/jwtutil"
	"github.com/danielgtaylor/huma/v2"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// AppInfo holds application metadata.
type AppInfo struct {
	Name      string
	Version   string
	BuildTime string
	GitCommit string
	JWTAuth   *jwtutil.Auth
}

// Handlers is the HTTP handler collection.
// Storage/cache/lock/retry are accessed via pkg/ package-level singletons.
type Handlers struct {
	cfg       *configs.Config
	info      AppInfo
	db        *gorm.DB
	events    eventbus.Bus
	startTime time.Time
	jwtAuth   *jwtutil.Auth
}

// New creates a new Handlers instance.
// events may be nil in tests; domain event publish becomes a no-op.
func New(cfg *configs.Config, info AppInfo, db *gorm.DB, events eventbus.Bus) *Handlers {
	return &Handlers{
		cfg:       cfg,
		info:      info,
		db:        db,
		events:    events,
		startTime: time.Now(),
		jwtAuth:   info.JWTAuth,
	}
}

// publish sends a domain event on the application event bus.
func (h *Handlers) publish(ctx context.Context, name string, source, payload any) {
	if h.events == nil {
		return
	}
	_ = h.events.Publish(ctx, eventbus.NewWithSource(name, source, payload))
}

// Register registers all routes via humax.Group (Gin + OpenAPI docs).
func (h *Handlers) Register(engine *gin.Engine, api huma.API) {
	r := humax.NewGroup(api, engine, "")
	h.registerRoutes(r)
}

// registerRoutes registers all route groups.
func (h *Handlers) registerRoutes(r *humax.Group) {
	h.registerSystemRoutes(r)
	h.registerAuthRoutes(r)
	h.registerUserRoutes(r)
	h.registerFileRoutes(r)
	h.registerAdminRoutes(r)
}

// registerAdminRoutes registers admin script management + front-end bootstrap.
func (h *Handlers) registerAdminRoutes(r *humax.Group) {
	r.GET("/api/v1/bootstrap", h.Bootstrap)

	admin := r.Group("/api/v1/admin")
	{
		admin.GET("/all", h.AdminAll)
		admin.POST("/scripts", h.CreateAdminScript)
		admin.PUT("/scripts/:id", h.UpsertAdminScript)
		admin.DELETE("/scripts/:id", h.DeleteAdminScript)
		admin.POST("/scripts/:id/file", h.UploadAdminScriptFile)
	}

	ai := r.Group("/api/v1/ai")
	{
		ai.POST("/inspect", h.AIInspect)
		ai.GET("/artifacts", h.AIExistingArtifacts)
		ai.GET("/artifacts/file", h.AIExistingArtifactFile)
		ai.POST("/jobs", h.AICreateJob)
		ai.GET("/jobs/:id", h.AIGetJob)
		ai.POST("/jobs/:id/pause", h.AIPauseJob)
		ai.POST("/jobs/:id/resume", h.AIResumeJob)
		ai.GET("/jobs/:id/files/:key", h.AIGetJobFile)
		ai.POST("/cover", h.AIGenerateCover)
	}

	// 买家购买后下载剧本 Word（与 Node 版路由保持一致）
	r.GET("/api/v1/scripts/:id/file", h.DownloadScriptFile)
}

// registerSystemRoutes registers public system endpoints (health, version).
func (h *Handlers) registerSystemRoutes(r *humax.Group) {
	r.GET("/health", h.Health)
	r.GET("/live", h.Liveness)
	r.GET("/ready", h.Readiness)
	r.GET("/api/v1/version", h.Version)
}

// registerAuthRoutes registers public auth endpoints (login, refresh).
func (h *Handlers) registerAuthRoutes(r *humax.Group) {
	auth := r.Group("/api/v1/auth")
	{
		auth.POST("/login", h.Login)
		auth.POST("/refresh", h.Refresh)
	}
}

// registerUserRoutes registers user registration (public) + user CRUD endpoints.
func (h *Handlers) registerUserRoutes(r *humax.Group) {
	// Public registration
	r.POST("/api/v1/register", h.RegisterUser)

	// User CRUD
	users := r.Group("/api/v1/users")
	{
		users.GET("", h.ListUsers)
		users.GET("/:id", h.GetUser)
		users.POST("", h.CreateUser)
		users.PUT("/:id", h.UpdateUser)
		users.PUT("/:id/password", h.ChangePassword)
		users.DELETE("/:id", h.DeleteUser)
	}
}

// registerFileRoutes registers file upload/download/delete endpoints.
func (h *Handlers) registerFileRoutes(r *humax.Group) {
	files := r.Group("/api/v1/files")
	{
		files.POST("/upload", h.UploadFile)
		files.GET("/:key", h.DownloadFile)
		files.DELETE("/:key", h.DeleteFile)
	}
}
