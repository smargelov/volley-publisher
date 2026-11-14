import { Action, ActionPanel, Form, Icon, showToast, Toast, useNavigation } from '@raycast/api'
import { usePromise } from '@raycast/utils'
import { useState } from 'react'
import {
  buildPlan,
  createPlaylist,
  formatDuration,
  listPlaylists,
  loadCropChoice,
  loadStore,
  parseTimecode,
  playlistKey,
  probeFile,
  rememberAnswers,
  resolvePlayersAuto,
  saveStore,
  slugify,
  translateStageAndNotes,
  type ChannelVideo,
  type Discipline,
} from '../lib/core'
import { startEditor } from '../lib/editor'
import { Review } from './Review'

/** Dropdown values for "add a new one" and "none". */
const NEW = '__new__'
const NONE = '__none__'

interface FormValues {
  event: string
  newEventRu: string
  newEventEn: string
  venue: string
  newVenueName: string
  newVenueCity: string
  newVenueCountry: string
  discipline: string
  playlist: string
  newPlaylistTitle: string
  teamA: string
  teamB: string
  stage: string
  score: string
  notes: string
  moment: string
  reuseFrame: boolean
}

async function loadFormData(item: ChannelVideo) {
  if (!item.localPath) throw new Error('Source file is not in inbox or done')
  const [store, playlists, file] = await Promise.all([loadStore(), listPlaylists(), probeFile(item.localPath)])
  const savedCrop = await loadCropChoice(file.path)
  return { store, playlists, file, hasSavedCrop: savedCrop !== null }
}

/** Collects everything about a video, saves it and opens the thumbnail editor. */
export function DetailsForm({ item, onSaved }: { item: ChannelVideo; onSaved: () => void }) {
  const { push } = useNavigation()
  const { data, isLoading, error } = usePromise(loadFormData, [item])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [event, setEvent] = useState<string>()
  const [venue, setVenue] = useState<string>()
  const [playlist, setPlaylist] = useState<string>()
  const [errors, setErrors] = useState<Partial<Record<keyof FormValues, string>>>({})

  if (error) {
    return (
      <Form>
        <Form.Description title="Error" text={error.message} />
      </Form>
    )
  }
  if (!data) return <Form isLoading={isLoading} />

  const { store, playlists, file, hasSavedCrop } = data
  const session = store.sessions[file.localDate]
  const previous = store.videos[item.video.id]

  // Defaults come from the answers given for the same shooting day, then from the last used entries.
  const eventValue = event ?? session?.eventTypeId ?? store.eventTypes[0]?.id ?? NEW
  const venueValue = venue ?? session?.venueId ?? store.venues[0]?.id ?? NEW
  const rememberedPlaylist = store.playlistByKey[playlistKey(eventValue, venueValue)]?.id
  const playlistDefault = session ? (session.playlistId ?? NONE) : (rememberedPlaylist ?? NEW)
  const playlistValue = playlist ?? (playlists.some((p) => p.id === playlistDefault) ? playlistDefault : NEW)

  const selectedEvent = store.eventTypes.find((e) => e.id === eventValue)
  const selectedVenue = store.venues.find((v) => v.id === venueValue)
  const suggestedPlaylistTitle =
    selectedEvent && selectedVenue ? `${selectedEvent.nameEn} - ${selectedVenue.name}` : undefined
  const lastVenue = store.venues.at(-1)

  function validate(values: FormValues): boolean {
    const found: Partial<Record<keyof FormValues, string>> = {}
    if (values.event === NEW && !values.newEventRu.trim()) found.newEventRu = 'Required'
    if (values.event === NEW && !values.newEventEn.trim()) found.newEventEn = 'Required'
    if (values.venue === NEW && !values.newVenueName.trim()) found.newVenueName = 'Required'
    if (values.venue === NEW && !values.newVenueCity.trim()) found.newVenueCity = 'Required'
    if (values.venue === NEW && !values.newVenueCountry.trim()) found.newVenueCountry = 'Required'
    if (values.teamA.trim() && !values.teamB.trim()) found.teamB = 'Add the second team or clear the first'
    if (values.moment.trim()) {
      const seconds = parseTimecode(values.moment)
      if (seconds === null || seconds >= file.durationSec) {
        found.moment = `Use m:ss inside the video (${formatDuration(file.durationSec)})`
      }
    }
    setErrors(found)
    return Object.keys(found).length === 0
  }

  async function submit(values: FormValues) {
    if (!validate(values)) return
    setIsSubmitting(true)
    const toast = await showToast({ style: Toast.Style.Animated, title: 'Saving details…' })
    try {
      // New dictionary entries are added once and offered in the dropdowns from then on.
      let eventId = values.event
      if (eventId === NEW) {
        const created = {
          id: slugify(values.newEventEn),
          nameRu: values.newEventRu.trim(),
          nameEn: values.newEventEn.trim(),
        }
        store.eventTypes.push(created)
        eventId = created.id
      }
      let venueId = values.venue
      if (venueId === NEW) {
        const created = {
          id: slugify(values.newVenueName),
          name: values.newVenueName.trim(),
          city: values.newVenueCity.trim(),
          country: values.newVenueCountry.trim(),
        }
        store.venues.push(created)
        venueId = created.id
      }
      const eventName = store.eventTypes.find((e) => e.id === eventId)?.nameEn ?? ''
      const venueName = store.venues.find((v) => v.id === venueId)?.name ?? ''

      let chosenPlaylist = playlists.find((p) => p.id === values.playlist)
      if (values.playlist === NEW) {
        chosenPlaylist = await createPlaylist(values.newPlaylistTitle.trim() || `${eventName} - ${venueName}`)
      }
      if (chosenPlaylist) store.playlistByKey[playlistKey(eventId, venueId)] = chosenPlaylist

      store.sessions[file.localDate] = {
        eventTypeId: eventId,
        venueId,
        discipline: values.discipline as Discipline,
        playlistId: chosenPlaylist?.id,
        playlistTitle: chosenPlaylist?.title,
      }

      const stage = values.stage.trim()
      const notes = values.notes.trim()
      toast.title = 'Translating…'
      const translated = await translateStageAndNotes(store, stage, notes, previous)
      // Registers new player names so their spelling stays the same from now on.
      resolvePlayersAuto(store, values.teamA)
      resolvePlayersAuto(store, values.teamB)

      rememberAnswers(store, item.video, {
        teamA: values.teamA.trim(),
        teamB: values.teamB.trim(),
        part: stage,
        partEn: translated.partEn,
        score: values.score.trim(),
        notes,
        notesEn: translated.notesEn,
      })
      await saveStore(store)

      const plan = buildPlan(store, file, item.video.id)
      if (!plan) throw new Error('Could not build the video details')

      // The editor opens in the browser and keeps running even if Raycast is closed.
      const momentSec = values.moment.trim() ? parseTimecode(values.moment) : null
      const opensEditor = momentSec !== null || (hasSavedCrop && values.reuseFrame)
      if (opensEditor) startEditor({ videoPath: file.path, momentSec, overlay: plan.overlay }, item.video.id)

      toast.style = translated.warning ? Toast.Style.Failure : Toast.Style.Success
      toast.title = translated.warning ?? (opensEditor ? 'Thumbnail editor opened in the browser' : 'Details saved')
      onSaved()
      push(<Review item={item} onSaved={onSaved} />)
    } catch (error) {
      toast.style = Toast.Style.Failure
      toast.title = 'Could not save details'
      toast.message = error instanceof Error ? error.message : String(error)
    } finally {
      setIsSubmitting(false)
    }
  }

  const clear = (field: keyof FormValues) => () => setErrors((current) => ({ ...current, [field]: undefined }))

  return (
    <Form
      isLoading={isLoading || isSubmitting}
      navigationTitle={file.fileName}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save and Continue" icon={Icon.ArrowRight} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Video"
        text={`${file.localDate} ${file.localTime} · ${formatDuration(file.durationSec)} · ${file.camera}`}
      />

      <Form.Dropdown id="event" title="Games" value={eventValue} onChange={setEvent}>
        {store.eventTypes.map((e) => (
          <Form.Dropdown.Item key={e.id} value={e.id} title={`${e.nameRu} (${e.nameEn})`} />
        ))}
        <Form.Dropdown.Item value={NEW} title="Add a new type…" icon={Icon.Plus} />
      </Form.Dropdown>
      {eventValue === NEW && (
        <>
          <Form.TextField
            id="newEventRu"
            title="Type, as You Call It"
            placeholder="Движуха"
            error={errors.newEventRu}
            onChange={clear('newEventRu')}
          />
          <Form.TextField
            id="newEventEn"
            title="Type, in English"
            placeholder="Open Play"
            error={errors.newEventEn}
            onChange={clear('newEventEn')}
          />
        </>
      )}

      <Form.Dropdown id="venue" title="Venue" value={venueValue} onChange={setVenue}>
        {store.venues.map((v) => (
          <Form.Dropdown.Item key={v.id} value={v.id} title={`${v.name}, ${v.city}`} />
        ))}
        <Form.Dropdown.Item value={NEW} title="Add a new venue…" icon={Icon.Plus} />
      </Form.Dropdown>
      {venueValue === NEW && (
        <>
          <Form.TextField
            id="newVenueName"
            title="Venue Name (English)"
            error={errors.newVenueName}
            onChange={clear('newVenueName')}
          />
          <Form.TextField
            id="newVenueCity"
            title="City"
            defaultValue={lastVenue?.city}
            error={errors.newVenueCity}
            onChange={clear('newVenueCity')}
          />
          <Form.TextField
            id="newVenueCountry"
            title="Country"
            defaultValue={lastVenue?.country}
            error={errors.newVenueCountry}
            onChange={clear('newVenueCountry')}
          />
        </>
      )}

      <Form.Dropdown id="discipline" title="Discipline" defaultValue={session?.discipline ?? 'beach'}>
        <Form.Dropdown.Item value="beach" title="Beach volleyball" />
        <Form.Dropdown.Item value="indoor" title="Indoor volleyball" />
      </Form.Dropdown>

      <Form.Dropdown id="playlist" title="Playlist" value={playlistValue} onChange={setPlaylist}>
        {playlists.map((p) => (
          <Form.Dropdown.Item key={p.id} value={p.id} title={p.title} />
        ))}
        <Form.Dropdown.Item value={NEW} title="Create a new playlist…" icon={Icon.Plus} />
        <Form.Dropdown.Item value={NONE} title="Do not add to a playlist" />
      </Form.Dropdown>
      {playlistValue === NEW && (
        <Form.TextField
          id="newPlaylistTitle"
          title="New Playlist Title"
          placeholder={suggestedPlaylistTitle ?? 'Event - Venue'}
          info="Leave empty to use the suggested title. The playlist is created as public."
        />
      )}

      <Form.Separator />
      <Form.TextField
        id="teamA"
        title="Team 1"
        placeholder="Анна, Maria"
        defaultValue={previous?.teamA}
        info="Player or team names separated by commas. Leave both teams empty when they are not known."
      />
      <Form.TextField
        id="teamB"
        title="Team 2"
        placeholder="Вадим, Валя"
        defaultValue={previous?.teamB}
        error={errors.teamB}
        onChange={clear('teamB')}
      />
      <Form.TextField
        id="stage"
        title="Stage or Set"
        placeholder="Полуфинал, Сет 2"
        defaultValue={previous?.part}
        info="Any language. Goes into the title, the thumbnail and the description."
      />
      <Form.TextField id="score" title="Score" placeholder="21:18" defaultValue={previous?.score} />
      <Form.TextArea
        id="notes"
        title="Notes"
        placeholder="Anything worth adding to the description, in any language"
        defaultValue={previous?.notes}
      />

      <Form.Separator />
      <Form.TextField
        id="moment"
        title="Thumbnail Moment"
        placeholder="5:53"
        error={errors.moment}
        onChange={clear('moment')}
        info="Time of the moment for the thumbnail (m:ss). The frame and the crop are picked in the browser."
      />
      {hasSavedCrop && (
        <Form.Checkbox
          id="reuseFrame"
          label="No new moment: rebuild the thumbnail from the frame picked earlier"
          defaultValue={true}
          info="Used when the moment above is empty. Updates the texts on the thumbnail without cropping again."
        />
      )}
    </Form>
  )
}
