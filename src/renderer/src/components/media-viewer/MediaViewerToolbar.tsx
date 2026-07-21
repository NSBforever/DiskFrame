import React from 'react'
import {
  Heart,
  Download,
  FolderOpen,
  Copy,
  Info,
  Trash2,
  X,
  RotateCcw,
  RotateCw,
  FlipHorizontal,
  ZoomIn,
  ZoomOut,
  Maximize,
  Maximize2,
  Minimize2
} from 'lucide-react'

interface MediaViewerToolbarProps {
  fileName: string
  filePath: string
  isFav: boolean
  onFav: () => void
  onReveal: () => void
  onClose: () => void
  onRotateLeft: () => void
  onRotateRight: () => void
  onFlip: () => void
  scale: number
  onZoomChange: (newScale: number) => void
  onFitWidth: () => void
  onFitHeight: () => void
  onActualSize: () => void
  onDownload: () => void
  onCopyPath: () => void
  onDelete: () => void
  onToggleInfo: () => void
  isInfoOpen: boolean
}

const IconBtn: React.FC<{
  onClick: (e: React.MouseEvent) => void
  title?: string
  children: React.ReactNode
  active?: boolean
  danger?: boolean
}> = ({ onClick, title, children, active, danger }) => (
  <button
    onClick={onClick}
    title={title}
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '36px',
      height: '36px',
      borderRadius: '4px', // CRED Style sharp edges
      border: `1px solid ${active ? '#e11d2e' : 'rgba(255,255,255,0.05)'}`,
      cursor: 'pointer',
      background: active ? 'rgba(225, 29, 46, 0.15)' : 'transparent',
      color: active ? '#e11d2e' : danger ? '#e11d2e' : '#d0d0e0',
      transition: 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), border-color 0.2s, background-color 0.2s',
      flexShrink: 0
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.borderColor = active ? '#e11d2e' : danger ? '#ff2b3d' : 'rgba(255,255,255,0.15)'
      e.currentTarget.style.background = active ? 'rgba(225, 29, 46, 0.2)' : danger ? 'rgba(225, 29, 46, 0.1)' : 'rgba(255,255,255,0.02)'
      e.currentTarget.style.color = active || danger ? '#e11d2e' : '#ffffff'
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.borderColor = active ? '#e11d2e' : 'rgba(255,255,255,0.05)'
      e.currentTarget.style.background = active ? 'rgba(225, 29, 46, 0.15)' : 'transparent'
      e.currentTarget.style.color = active ? '#e11d2e' : danger ? '#e11d2e' : '#d0d0e0'
      e.currentTarget.style.transform = 'scale(1)'
    }}
    onMouseDown={(e) => {
      if (e.button === 0) e.currentTarget.style.transform = 'scale(0.9)'
    }}
    onMouseUp={(e) => {
      if (e.button === 0) e.currentTarget.style.transform = 'scale(1)'
    }}
  >
    {children}
  </button>
)

export const MediaViewerToolbar: React.FC<MediaViewerToolbarProps> = ({
  fileName,
  isFav,
  onFav,
  onReveal,
  onClose,
  onRotateLeft,
  onRotateRight,
  onFlip,
  scale,
  onZoomChange,
  onFitWidth,
  onFitHeight,
  onActualSize,
  onDownload,
  onCopyPath,
  onDelete,
  onToggleInfo,
  isInfoOpen
}) => {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="media-viewer-controls"
      style={{
        position: 'absolute',
        top: '12px',
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        background: 'rgba(10,10,12,0.92)',
        backdropFilter: 'blur(20px) saturate(1.2)',
        border: '1px solid rgba(225,29,46,0.25)', // CRED red thin border
        borderRadius: '4px', // CRED sharp corners
        padding: '6px 12px',
        zIndex: 1000,
        boxShadow: 'none',
        maxWidth: 'calc(100vw - 40px)',
        minWidth: '720px',
        justifyContent: 'space-between',
        userSelect: 'none'
      }}
    >
      {/* File name */}
      <div
        style={{
          fontSize: '11px',
          fontWeight: 700,
          color: '#b0b0c8',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: '180px',
          padding: '0 6px',
          textTransform: 'uppercase',
          letterSpacing: '0.5px'
        }}
        title={fileName}
      >
        {fileName}
      </div>

      <div style={{ width: '1px', height: '22px', background: 'rgba(255,255,255,0.06)', flexShrink: 0 }} />

      {/* Zoom Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <IconBtn onClick={() => onZoomChange(scale - 0.5)} title="Zoom Out ( - )">
          <ZoomOut size={16} />
        </IconBtn>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', margin: '0 6px' }}>
          <input
            type="range"
            min="100"
            max="800"
            value={Math.round(scale * 100)}
            onChange={(e) => onZoomChange(Number(e.target.value) / 100)}
            style={{
              width: '80px',
              height: '4px',
              outline: 'none',
              cursor: 'pointer'
            }}
          />
          <div style={{ fontSize: '8px', fontWeight: 700, color: '#e11d2e', marginTop: '2px', minWidth: '32px', textAlign: 'center', letterSpacing: '0.5px' }}>
            {Math.round(scale * 100)}%
          </div>
        </div>
        <IconBtn onClick={() => onZoomChange(scale + 0.5)} title="Zoom In ( + )">
          <ZoomIn size={16} />
        </IconBtn>

        {/* Zoom Presets */}
        <IconBtn onClick={onFitWidth} title="Fit Width">
          <Maximize2 size={16} />
        </IconBtn>
        <IconBtn onClick={onFitHeight} title="Fit Height">
          <Minimize2 size={16} />
        </IconBtn>
        <IconBtn onClick={onActualSize} title="Actual Size (1:1 / 0)">
          <Maximize size={16} />
        </IconBtn>
      </div>

      <div style={{ width: '1px', height: '22px', background: 'rgba(255,255,255,0.06)', flexShrink: 0 }} />

      {/* Transform Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
        <IconBtn onClick={onRotateLeft} title="Rotate Left">
          <RotateCcw size={16} />
        </IconBtn>
        <IconBtn onClick={onRotateRight} title="Rotate Right">
          <RotateCw size={16} />
        </IconBtn>
        <IconBtn onClick={onFlip} title="Flip Horizontal">
          <FlipHorizontal size={16} />
        </IconBtn>
      </div>

      <div style={{ width: '1px', height: '22px', background: 'rgba(255,255,255,0.06)', flexShrink: 0 }} />

      {/* Utility Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
        <IconBtn onClick={onFav} title={isFav ? 'Remove from Favourites' : 'Add to Favourites'} active={isFav}>
          <Heart size={16} fill={isFav ? '#e11d2e' : 'none'} />
        </IconBtn>
        <IconBtn onClick={onDownload} title="Download File">
          <Download size={16} />
        </IconBtn>
        <IconBtn onClick={onReveal} title="Show in Folder">
          <FolderOpen size={16} />
        </IconBtn>
        <IconBtn onClick={onCopyPath} title="Copy Absolute Path">
          <Copy size={16} />
        </IconBtn>
        <IconBtn onClick={onToggleInfo} title="Toggle Info (EXIF)" active={isInfoOpen}>
          <Info size={16} />
        </IconBtn>
        <IconBtn onClick={onDelete} title="Delete File" danger={true}>
          <Trash2 size={16} />
        </IconBtn>
      </div>

      <div style={{ width: '1px', height: '22px', background: 'rgba(255,255,255,0.06)', flexShrink: 0 }} />

      {/* Close button */}
      <IconBtn onClick={onClose} title="Close Viewer (Esc)">
        <X size={16} />
      </IconBtn>
    </div>
  )
}

export default MediaViewerToolbar
