export interface ZoteroCreator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface ZoteroTag {
  tag: string;
  type?: number;
}

export interface ZoteroItemData {
  key: string;
  version?: number;
  itemType: string;
  title?: string;
  abstractNote?: string;
  date?: string;
  dateAdded?: string;
  dateModified?: string;
  creators?: ZoteroCreator[];
  tags?: ZoteroTag[];
  collections?: string[];
  publicationTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  place?: string;
  DOI?: string;
  url?: string;
  extra?: string;
  note?: string;
  contentType?: string;
  filename?: string;
  parentItem?: string;
  [key: string]: unknown;
}

export interface ZoteroItem {
  key: string;
  version: number;
  library: {
    type: string;
    id: number;
    name: string;
  };
  data: ZoteroItemData;
  meta?: {
    numChildren?: number;
    [key: string]: unknown;
  };
}

export interface ZoteroCollection {
  key: string;
  version: number;
  data: {
    key: string;
    name: string;
    parentCollection?: string | false;
    [key: string]: unknown;
  };
  meta?: {
    numCollections?: number;
    numItems?: number;
  };
}

export interface ZoteroFulltext {
  content: string;
  indexedPages?: number;
  totalPages?: number;
}

export interface ZoteroAnnotationData {
  annotationType?: string;
  annotationText?: string;
  annotationComment?: string;
  annotationPageLabel?: string;
  annotationColor?: string;
  annotationSortIndex?: string;
  annotationPosition?: string;
  parentItem?: string;
  [key: string]: unknown;
}

export interface AttachmentInfo {
  key: string;
  title: string;
  filename: string;
  contentType: string;
  path?: string;
}

export interface LibraryInfo {
  libraryID: number;
  type: string;
  editable: number;
  groupID?: number;
  groupName?: string;
  groupDescription?: string;
  feedName?: string;
  feedUrl?: string;
  feedLastCheck?: string;
  feedLastUpdate?: string;
  itemCount: number;
}

export interface FeedInfo {
  libraryID: number;
  name: string;
  url: string;
  lastCheck?: string;
  lastUpdate?: string;
  lastCheckError?: string;
  refreshInterval?: number;
  itemCount: number;
}

export interface FeedItem {
  itemID: number;
  key: string;
  itemType: string;
  dateAdded: string;
  readTime?: string;
  translatedTime?: string;
  title?: string;
  abstract?: string;
  url?: string;
  creators?: string;
}

export interface ActiveLibrary {
  libraryId: string;
  libraryType: string;
}

export interface RuntimeCapabilities {
  localApiRead: boolean;
  localApiWrite: boolean;
  localConnector: boolean;
  localBridge: boolean;
  sqliteFallback: boolean;
  localApiWriteStatus?: number;
  localApiWriteMessage?: string;
  localBridgeVersion?: string;
  zoteroVersion?: string;
}

export interface AttachmentRow {
  parentKey: string;
  attachmentKey: string;
  contentType: string;
  path: string | null;
}

export interface ItemFiles {
  hasPdf: boolean;
  hasTxt: boolean;
  hasMd: boolean;
  pdfPath?: string;
  txtPath?: string;
  txtSize?: number;
  mdPath?: string;
  mdSize?: number;
}

export interface FileInventoryEntry {
  attachmentKey: string;
  title: string;
  filename: string;
  contentType: string;
  files: ItemFiles;
}
