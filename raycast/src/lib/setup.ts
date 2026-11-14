// Imported for its side effects by every command before the core is used.
import { environment } from '@raycast/api'
import { setAssetsDir } from './core'
import { extendToolsPath } from './tools-path'

extendToolsPath()
setAssetsDir(environment.assetsPath)
