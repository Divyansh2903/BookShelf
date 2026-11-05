# Design Youtube

<<<SECTION 1>>>
## Overview (Problem Statement)

Designing a platform like YouTube is essentially building a clean, well-organized blueprint that lets code grow without breaking. By looking at how real people use YouTube: subscribing to channels, liking videos, and replying to comments, we can design a smart, reliable structure (at least).

This article breaks down the low-level design of a video platform. We will look at how the code is structured, how different parts talk to each other, and the core design rules that keep the system flexible.

I have tried my best to keep it beginner-friendly..However, I would recommend reading [1st LLD article](/articles/lld-concepts) (for concepts) and solving some design-based questions on leetcode.

## Architecture and Class Relationships

Before jumping into the actual code, let's look at the big picture. In object-oriented programming, classes connect to each other in a few standard ways:

- **Inheritance ("Is-A" Relationship):** A Creator is a User. Creators can do everything a regular user can do (like watch videos), but they also get special tools (like uploading videos).
- **Composition ("Part-Of" Relationship):** A Video belongs strictly to a Creator. If a creator deletes their channel, their videos are deleted too. The video cannot exist without its creator.
- **Aggregation ("Has-A" Relationship):** A Creator has a list of subscribers (Users). However, these users exist independently. If a creator deletes their channel, the users' accounts stay perfectly safe.
- **Composite Structure ("Self-Referencing"):** A Comment can contain other Comment objects as replies. This allows for deep, nested conversation threads.

<<<SECTION 2>>>
## Core Domain Classes

### 1. State Configuration

A video goes through different stages in its life. We use an Enum (a special list of fixed constants) to keep track of whether a video is still processing, public, private, or deleted.

```java
enum VideoState {
    PUBLIC, PRIVATE, PROCESSING, DELETED
}
```

### 2. The User

The User class represents a standard person on the platform. It holds their profile data (ID, name) and tracks their personal interactions, like their watch history, liked videos, and subscriptions.

```java
class User {
    private String userId;
    private String name;
    private List<Creator> subscribedTo;
    private List<Video> watchHistory;
    private List<Video> likedVideos;
    private int watchedHours;

    public User(String userId, String name) {
        this.userId = userId;
        this.name = name;
        this.subscribedTo = new ArrayList<>();
        this.watchHistory = new ArrayList<>();
        this.likedVideos = new ArrayList<>();
        this.watchedHours = 0;
    }

    // Like a video — updates both User's likedVideos and Video's likes list
    public void likeAVideo(Video video) {
        if (!likedVideos.contains(video)) {
            likedVideos.add(video);
            video.addLike(this);
        }
    }

    // Comment on a video with a body string
    public void commentOnAVideo(Video video, String body) {
        Comment comment = new Comment(
            java.util.UUID.randomUUID().toString(), body, this
        );
        video.addComment(comment);
    }

    // Share a video: increments the share counter
    public void shareAVideo(Video video) {
        video.incrementShares();
    }

    // Subscribe: bidirectional update
    public void subscribeToCreator(Creator creator) {
        if (!subscribedTo.contains(creator)) {
            subscribedTo.add(creator);
            creator.addSubscriber(this);
        }
    }

    // Unsubscribe: bidirectional update
    public void unsubscribeFromCreator(Creator creator) {
        subscribedTo.remove(creator);
        creator.removeSubscriber(this);
    }

    public void clearHistory() {
        watchHistory.clear();
    }

    public void deleteFromHistory(Video video) {
        watchHistory.remove(video);
    }

    // Called by the system when a video is watched
    void addToHistory(Video video) {
        if (!watchHistory.contains(video)) {
            watchHistory.add(video);
        }
    }

    // Getters
    public String getUserId() { return userId; }
    public String getName() { return name; }
    public List<Video> getLikedVideos() { return likedVideos; }
    public List<Video> getWatchHistory() { return watchHistory; }
}
```

### 3. The Content Creator

Because a Creator extends User, it automatically gets all the code we just wrote for regular users. On top of that, it adds specific creator behaviors, like managing a list of uploaded videos and tracking subscribers.

```java
class Creator extends User {
    private List<Video> videos;        // Composition
    private List<User> subscribers;    // Aggregation
    private double earnings;

    public Creator(String userId, String name) {
        super(userId, name);
        this.videos = new ArrayList<>();
        this.subscribers = new ArrayList<>();
        this.earnings = 0.0;
    }

    // Upload is composition: video belongs to creator
    public void uploadVideo(Video video) {
        videos.add(video);
        video.setState(VideoState.PUBLIC);
        notifySubscribers(video);   // Observer Pattern
    }

    public void deleteVideo(Video video) {
        videos.remove(video);
        video.setState(VideoState.DELETED);
    }

    // Observer Pattern, notify all subscribers
    public void notifySubscribers(Video video) {
        for (User subscriber : subscribers) {
            System.out.println(
                "Notifying " + subscriber.getName() +
                ": New video uploaded — " + video.getTitle()
            );
        }
    }

    // Called by User.subscribeToCreator()
    void addSubscriber(User user) {
        if (!subscribers.contains(user)) {
            subscribers.add(user);
        }
    }

    void removeSubscriber(User user) {
        subscribers.remove(user);
    }

    public List<Video> getVideos() { return videos; }
    public List<User> getSubscribers() { return subscribers; }
    public double getEarnings() { return earnings; }
}
```

### 4. The Video Model

The Video class acts as a container for everything related to a single video, including its title, runtime, who made it, and lists of users who liked or commented on it.

```java
class Video {
    private String videoId;
    private String title;
    private String description;
    private String thumbnail;       // URL string
    private int duration;           // in seconds
    private List<String> tags;
    private VideoState state;
    private Creator creator;
    private List<User> likes;
    private int shares;
    private List<Comment> comments;
    private LocalDateTime uploadedAt;

    public Video(String videoId, String title, String description,
                 String thumbnail, int duration,
                 List<String> tags, Creator creator) {
        this.videoId = videoId;
        this.title = title;
        this.description = description;
        this.thumbnail = thumbnail;
        this.duration = duration;
        this.tags = tags;
        this.creator = creator;
        this.state = VideoState.PROCESSING;
        this.likes = new ArrayList<>();
        this.shares = 0;
        this.comments = new ArrayList<>();
        this.uploadedAt = LocalDateTime.now();
    }

    public void addLike(User user) {
        if (!likes.contains(user)) {
            likes.add(user);
        }
    }

    public void addComment(Comment comment) {
        comments.add(comment);
    }

    public void incrementShares() {
        shares++;
    }

    public void setState(VideoState state) {
        this.state = state;
    }

    // Getters
    public String getVideoId() { return videoId; }
    public String getTitle() { return title; }
    public VideoState getState() { return state; }
    public Creator getCreator() { return creator; }
    public List<User> getLikes() { return likes; }
    public List<Comment> getComments() { return comments; }
    public int getShares() { return shares; }
}
```

### 5. Comments

On YouTube, comment sections aren't just flat lists; people reply to comments, and people reply to those replies. To handle this, each Comment object contains a list of other Comment objects inside it.

```java
class Comment {
    private String commentId;
    private String body;
    private User owner;
    private List<User> likes;
    private List<Comment> replies;   // Composite Pattern
    private LocalDateTime commentedAt;

    public Comment(String commentId, String body, User owner) {
        this.commentId = commentId;
        this.body = body;
        this.owner = owner;
        this.likes = new ArrayList<>();
        this.replies = new ArrayList<>();
        this.commentedAt = LocalDateTime.now();
    }

    public void likeComment(User user) {
        if (!likes.contains(user)) {
            likes.add(user);
        }
    }

    // Composite Pattern.. add a reply (which is itself a Comment)
    public void addReply(Comment reply) {
        replies.add(reply);
    }

    // Getters
    public String getCommentId() { return commentId; }
    public String getBody() { return body; }
    public User getOwner() { return owner; }
    public List<Comment> getReplies() { return replies; }
    public List<User> getLikes() { return likes; }
    public LocalDateTime getCommentedAt() { return commentedAt; }
}
```

<<<SECTION 3>>>
## SOLID Principles Applied

- **Single Responsibility Principle (SRP):** Each class owns exactly one concern. User manages user actions, Video holds video data, Comment handles comment structure. None bleeds into the other's territory.
- **Liskov Substitution Principle (LSP):** Creator extends User. A Creator can be used anywhere a User is expected, without breaking behaviour. A `List<User>` of subscribers naturally holds both regular users and creators.
- **Open/Closed Principle (OCP):** The design is open for extension. Want a PremiumUser? Extend User. Want a LiveStream? Extend Video. No existing class needs modification.
- **Interface Segregation Principle (ISP):** We didn't dump all methods into one bloated interface. Users and creators have separate method sets relevant to their own roles.

## Design Patterns Applied

1. **Observer Pattern:** When a Creator uploads a video, `notifySubscribers()` is triggered, pushing updates to all subscribers. Creator = Subject, User = Observer.
2. **Composite Pattern:** Comment holds a `List<Comment>` as replies. This recursive structure allows infinite nesting. A comment can have replies, which can themselves have replies.
3. **Factory Pattern:** UserFactory handles the creation logic for User vs Creator, keeping instantiation logic out of business code.

## Key Relationships

- Creator extends User - inheritance
- Creator has `List<Video>` - composition (videos can't exist without their creator)
- Creator has `List<User>` subscribers - aggregation (subscribers exist independently)
- Video has `List<Comment>` - association
- Comment has `List<Comment>` replies - self-referential (Composite Pattern)

<<<SECTION 4>>>
## Final code

```java
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

// ENUM

enum VideoState {
    PUBLIC, PRIVATE, PROCESSING, DELETED
}

// USER CLASS

class User {
    private String userId;
    private String name;
    private List<Creator> subscribedTo;
    private List<Video> watchHistory;
    private List<Video> likedVideos;
    private int watchedHours;

    public User(String userId, String name) {
        this.userId = userId;
        this.name = name;
        this.subscribedTo = new ArrayList<>();
        this.watchHistory = new ArrayList<>();
        this.likedVideos = new ArrayList<>();
        this.watchedHours = 0;
    }

    // Like a video- updates both User's likedVideos and Video's likes list
    public void likeAVideo(Video video) {
        if (!likedVideos.contains(video)) {
            likedVideos.add(video);
            video.addLike(this);
        }
    }

    // Comment on a video with a body string
    public void commentOnAVideo(Video video, String body) {
        Comment comment = new Comment(
            java.util.UUID.randomUUID().toString(), body, this
        );
        video.addComment(comment);
    }

    // Share a video- increments the share counter
    public void shareAVideo(Video video) {
        video.incrementShares();
    }

    // Subscribe- bidirectional update
    public void subscribeToCreator(Creator creator) {
        if (!subscribedTo.contains(creator)) {
            subscribedTo.add(creator);
            creator.addSubscriber(this);
        }
    }

    // Unsubscribe- bidirectional update
    public void unsubscribeFromCreator(Creator creator) {
        subscribedTo.remove(creator);
        creator.removeSubscriber(this);
    }

    public void clearHistory() {
        watchHistory.clear();
    }

    public void deleteFromHistory(Video video) {
        watchHistory.remove(video);
    }

    // Called by the system when a video is watched
    void addToHistory(Video video) {
        if (!watchHistory.contains(video)) {
            watchHistory.add(video);
        }
    }

    // Getters
    public String getUserId() { return userId; }
    public String getName() { return name; }
    public List<Video> getLikedVideos() { return likedVideos; }
    public List<Video> getWatchHistory() { return watchHistory; }
}

// CREATOR CLASS extends User
// LSP: Creator is-a User
// Observer Pattern: Creator is the Subject

class Creator extends User {
    private List<Video> videos;        // Composition
    private List<User> subscribers;    // Aggregation
    private double earnings;

    public Creator(String userId, String name) {
        super(userId, name);
        this.videos = new ArrayList<>();
        this.subscribers = new ArrayList<>();
        this.earnings = 0.0;
    }

    // Upload is composition: video belongs to creator
    public void uploadVideo(Video video) {
        videos.add(video);
        video.setState(VideoState.PUBLIC);
        notifySubscribers(video);   // Observer Pattern
    }

    public void deleteVideo(Video video) {
        videos.remove(video);
        video.setState(VideoState.DELETED);
    }

    // Observer Pattern - notify all subscribers
    public void notifySubscribers(Video video) {
        for (User subscriber : subscribers) {
            System.out.println(
                "Notifying " + subscriber.getName() +
                ": New video uploaded - " + video.getTitle()
            );
        }
    }

    // Called by User.subscribeToCreator()
    void addSubscriber(User user) {
        if (!subscribers.contains(user)) {
            subscribers.add(user);
        }
    }

    void removeSubscriber(User user) {
        subscribers.remove(user);
    }

    public List<Video> getVideos() { return videos; }
    public List<User> getSubscribers() { return subscribers; }
    public double getEarnings() { return earnings; }
}

// VIDEO CLASS

class Video {
    private String videoId;
    private String title;
    private String description;
    private String thumbnail;       // URL string
    private int duration;           // in seconds
    private List<String> tags;
    private VideoState state;
    private Creator creator;
    private List<User> likes;
    private int shares;
    private List<Comment> comments;
    private LocalDateTime uploadedAt;

    public Video(String videoId, String title, String description,
                 String thumbnail, int duration,
                 List<String> tags, Creator creator) {
        this.videoId = videoId;
        this.title = title;
        this.description = description;
        this.thumbnail = thumbnail;
        this.duration = duration;
        this.tags = tags;
        this.creator = creator;
        this.state = VideoState.PROCESSING;
        this.likes = new ArrayList<>();
        this.shares = 0;
        this.comments = new ArrayList<>();
        this.uploadedAt = LocalDateTime.now();
    }

    public void addLike(User user) {
        if (!likes.contains(user)) {
            likes.add(user);
        }
    }

    public void addComment(Comment comment) {
        comments.add(comment);
    }

    public void incrementShares() {
        shares++;
    }

    public void setState(VideoState state) {
        this.state = state;
    }

    // Getters
    public String getVideoId() { return videoId; }
    public String getTitle() { return title; }
    public VideoState getState() { return state; }
    public Creator getCreator() { return creator; }
    public List<User> getLikes() { return likes; }
    public List<Comment> getComments() { return comments; }
    public int getShares() { return shares; }
}

// COMMENT CLASS
// Composite Pattern: Comment has List<Comment>

class Comment {
    private String commentId;
    private String body;
    private User owner;
    private List<User> likes;
    private List<Comment> replies;   // Composite Pattern
    private LocalDateTime commentedAt;

    public Comment(String commentId, String body, User owner) {
        this.commentId = commentId;
        this.body = body;
        this.owner = owner;
        this.likes = new ArrayList<>();
        this.replies = new ArrayList<>();
        this.commentedAt = LocalDateTime.now();
    }

    public void likeComment(User user) {
        if (!likes.contains(user)) {
            likes.add(user);
        }
    }

    // Composite Pattern- add a reply (which is itself a Comment)
    public void addReply(Comment reply) {
        replies.add(reply);
    }

    // Getters
    public String getCommentId() { return commentId; }
    public String getBody() { return body; }
    public User getOwner() { return owner; }
    public List<Comment> getReplies() { return replies; }
    public List<User> getLikes() { return likes; }
    public LocalDateTime getCommentedAt() { return commentedAt; }
}

// FACTORY PATTERN — UserFactory

class UserFactory {
    public static User createUser(String userId, String name) {
        return new User(userId, name);
    }

    public static Creator createCreator(String userId, String name) {
        return new Creator(userId, name);
    }
}

// MAIN — Demo

public class YouTubeLLD {
    public static void main(String[] args) {

        // Factory creates objects
        Creator creator = UserFactory.createCreator("c1", "TechWithTim");
        User user1 = UserFactory.createUser("u1", "Alice");
        User user2 = UserFactory.createUser("u2", "Bob");

        // User subscribes to creator- Observer registered
        user1.subscribeToCreator(creator);
        user2.subscribeToCreator(creator);

        // Creator uploads video- Observer notified
        Video video = new Video(
            "v1", "LLD of YouTube", "Full LLD walkthrough",
            "https://thumbnail.url/lld.jpg", 1800,
            List.of("lld", "design", "java"), creator
        );
        creator.uploadVideo(video);
        // Console: Notifying Alice: New video uploaded - LLD of YouTube
        // Console: Notifying Bob: New video uploaded - LLD of YouTube

        // Users interact with the video
        user1.likeAVideo(video);
        user1.commentOnAVideo(video, "Great explanation!");
        user2.shareAVideo(video);

        // Nested comment is a Composite Pattern
        Comment parentComment = video.getComments().get(0);
        Comment reply = new Comment("c2", "Totally agree!", user2);
        parentComment.addReply(reply);

        // Watch history, system adds automatically
        user1.addToHistory(video);

        System.out.println("Likes: " + video.getLikes().size());       // 1
        System.out.println("Shares: " + video.getShares());            // 1
        System.out.println("Comments: " + video.getComments().size()); // 1
        System.out.println("Replies on comment: " +
            parentComment.getReplies().size());                         // 1
        System.out.println("Watch history size: " +
            user1.getWatchHistory().size());                            // 1
    }
}
```
