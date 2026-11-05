# Design a basic Music System

<<<SECTION 1>>>
Streaming apps like Spotify, Apple Music, and YouTube Music rely on solid object-oriented design. This is a simplified Music Playlist System in Java, illustrating key LLD concepts. It supports artists and songs, a central music library, user playlists, adding/removing songs, songs shared across playlists, and independent object lifecycles.

## Problem Statement

- Songs belong to artists.
- All songs live in a master library.
- Users can create multiple playlists.
- One song can be in multiple playlists.
- Deleting a playlist doesn't delete its songs (as in real music apps).

## Core Classes in the Design

- **Artist**: a music artist
- **Song**: a song
- **Playlist**: a collection of songs
- **User**: manages playlists
- **Library**: stores all songs

## 1. Artist Class

The simplest entity.

```java
class Artist {
    private String name;

    public Artist(String name) {
        this.name = name;
    }

    public String getName() {
        return name;
    }
}
```

Stores artist data and is a dependency for songs. Follows the **Single Responsibility Principle (SRP)**: it only manages artist data.

## 2. Song Class

The core entity.

```java
class Song {
    private String title;
    private Artist artist;
    private int duration;
}
```

Holds title, an Artist object, and duration in seconds. A Song refers to an Artist: a Has-A relationship (**association**).

> Song HAS-A Artist

<<<SECTION 2>>>
## 3. Playlist Class

Manages a collection of songs: add, remove, count songs, compute total duration.

```java
class Playlist {
    private String name;
    private List<Song> songs = new ArrayList<>();
}
```

```java
public void addSong(Song song) {
    songs.add(song);
}
```

**Aggregation:** a playlist doesn't own its songs; they exist independently.

> Playlist HAS-A collection of Songs

If a playlist is deleted, its songs still exist, may still be in other playlists, and remain in the library.

## 4. User Class

Creates, deletes, and stores playlists.

```java
class User {
    private String name;
    private List<Playlist> playlists = new ArrayList<>();
}
```

```java
public Playlist createPlaylist(String playlistName) {
    Playlist playlist = new Playlist(playlistName);
    playlists.add(playlist);
    return playlist;
}
```

A user manages playlists, but playlists remain independent entities, keeping the design flexible and scalable.

## 5. Library Class

Central song repository.

```java
class Library {
    private List<Song> songs = new ArrayList<>();
}
```

Without it, songs would be duplicated across playlists, using more memory and making management harder. Instead, playlists reference existing songs, which is memory-efficient and mirrors real systems.

## UML Diagram

{{IMG:1}}

<<<SECTION 3>>>
## Key LLD Concepts Used

1. **Encapsulation:** all fields are private; access goes through getters and methods, protecting internal state.

```java
private String title;
```

2. **Association:** a song is associated with an artist.
3. **Aggregation:** Playlist -> Songs; playlists use songs but don't own their lifecycle.
4. **Single Responsibility Principle:** one job per class. Artist: artist details; Song: song details; Playlist: playlist operations; User: user operations; Library: song storage.
5. **Reusability:** one song object is reused across playlists.

```java
workout.addSong(hello);
chill.addSong(hello);
```

## Time Complexity Analysis

- Add song to playlist: `O(1)`
- Remove song: `O(n)`
- Total duration: `O(n)`
- Create playlist: `O(1)`

## Full code

```java
import java.util.ArrayList;
import java.util.List;

class Artist {
    private final String name;

    public Artist(String name) {
        this.name = name;
    }

    public String getName() {
        return name;
    }
}

class Song {
    private final String title;
    private final Artist artist;
    private final int duration;

    public Song(String title, Artist artist, int duration) {
        this.title = title;
        this.artist = artist;
        this.duration = duration;
    }

    public String getTitle() {
        return title;
    }

    public Artist getArtist() {
        return artist;
    }

    public int getDuration() {
        return duration;
    }

    @Override
    public String toString() {
        return title + " - " + artist.getName()
                + " [" + duration + " sec]";
    }
}

class Playlist {
    private final String name;
    private final List<Song> songs;

    public Playlist(String name) {
        this.name = name;
        this.songs = new ArrayList<>();
    }

    public void addSong(Song song) {
        songs.add(song);
    }

    public void removeSong(Song song) {
        songs.remove(song);
    }

    public int getSongCount() {
        return songs.size();
    }

    public int getTotalDuration() {
        int duration = 0;

        for (Song song : songs) {
            duration += song.getDuration();
        }

        return duration;
    }

    public String getName() {
        return name;
    }

    public List<Song> getSongs() {
        return songs;
    }
}

class User {
    private final String name;
    private final List<Playlist> playlists;

    public User(String name) {
        this.name = name;
        this.playlists = new ArrayList<>();
    }

    public Playlist createPlaylist(String playlistName) {
        Playlist playlist = new Playlist(playlistName);
        playlists.add(playlist);

        return playlist;
    }

    public void deletePlaylist(Playlist playlist) {
        playlists.remove(playlist);
    }

    public String getName() {
        return name;
    }

    public List<Playlist> getPlaylists() {
        return playlists;
    }
}

class Library {
    private final List<Song> songs;

    public Library() {
        songs = new ArrayList<>();
    }

    public void addSong(Song song) {
        songs.add(song);
    }

    public int getSongCount() {
        return songs.size();
    }

    public List<Song> getSongs() {
        return songs;
    }
}

public class Main {

    public static void main(String[] args) {

        Artist coldplay = new Artist("Coldplay");
        Artist adele = new Artist("Adele");

        Song yellow = new Song("Yellow", coldplay, 269);
        Song clocks = new Song("Clocks", coldplay, 307);
        Song hello = new Song("Hello", adele, 295);
        Song someoneLikeYou = new Song("Someone Like You", adele, 285);

        Library library = new Library();

        library.addSong(yellow);
        library.addSong(clocks);
        library.addSong(hello);
        library.addSong(someoneLikeYou);

        User alice = new User("Alice");

        Playlist workout = alice.createPlaylist("Workout Mix");
        Playlist chill = alice.createPlaylist("Chill Vibes");

        workout.addSong(yellow);
        workout.addSong(clocks);
        workout.addSong(hello);

        chill.addSong(hello);
        chill.addSong(someoneLikeYou);

        System.out.println("Songs present in library : "
                + library.getSongCount());

        System.out.println();

        System.out.println(
                workout.getName()
                        + " -> "
                        + workout.getSongCount()
                        + " songs, Duration : "
                        + workout.getTotalDuration() + "s"
        );

        for (Song song : workout.getSongs()) {
            System.out.println(" * " + song);
        }

        System.out.println();

        System.out.println(
                chill.getName()
                        + " -> "
                        + chill.getSongCount()
                        + " songs, Duration : "
                        + chill.getTotalDuration() + "s"
        );

        for (Song song : chill.getSongs()) {
            System.out.println(" * " + song);
        }

        System.out.println();

        alice.deletePlaylist(workout);

        System.out.println("After removing playlist : "
                + workout.getName());

        System.out.println("Library song count remains : "
                + library.getSongCount());

        System.out.println("Playlist '"
                + chill.getName()
                + "' still contains "
                + chill.getSongCount()
                + " songs");

        System.out.println("'"
                + yellow.getTitle()
                + "' still exists independently.");
    }
}
```
